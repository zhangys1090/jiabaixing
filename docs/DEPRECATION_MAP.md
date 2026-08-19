# TS → Python 废弃文件迁移映射

> 当 `AGENT_BACKEND=python`（默认）时，以下 TS 文件不再被主流程使用，
> 但保留在 `AGENT_BACKEND=local` 回退模式中以供兼容。
>
> **V5.5 更新** (2026-07-14): Python 端已完成 Facade 拆分和中间件化，
> 架构质量显著提升。V6.0 将移除所有 TS 端 AI 核心组件。
>
> **V5.6 更新** (2026-08-16): DI 容器增强完成，37 个单例类已登记迁移映射。
> 新代码应通过 `DIContainer.resolve()` 获取依赖，不再直接调用 `getInstance()`。
>
> **V6.0 更新** (2026-08-17): P0+P1 单例迁移完成 (18/37)，所有迁移类已添加 `create()` 工厂方法。
> API 契约定义完成 (44 端点)，废弃模块代理层 (DeprecatedModuleProxy) 已就绪。

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

## Singleton → DI 迁移映射 (V5.6)

> 以下 37 个 `getInstance()` 单例类已登记在 `DependencyRegistry.SINGLETON_MIGRATION_MAP` 中。
> 迁移进度可通过 `getMigrationStats()` 查询。

| 优先级 | 类名 | DI_TOKEN | 模块路径 | 迁移状态 |
|--------|------|----------|---------|---------|
| P0 | TimerManager | TIMER_MANAGER | utils/TimerManager | 📋 待迁移 |
| P0 | MemoryLeakGuard | MEMORY_LEAK_GUARD | utils/MemoryLeakGuard | 📋 待迁移 |
| P0 | EnvironmentManager | ENVIRONMENT_MANAGER | utils/EnvironmentManager | 📋 待迁移 |
| P0 | ConfigLoader | CONFIG_LOADER | config/ConfigLoader | 📋 待迁移 |
| P0 | EventBus | EVENT_BUS | shared/EventBus | 📋 待迁移 |
| P0 | SystemInitState | SYSTEM_INIT_STATE | server/SystemInitState | 📋 待迁移 |
| P1 | SecurityPolicyEngine | SECURITY_POLICY_ENGINE | security/SecurityPolicyEngine | 📋 待迁移 |
| P1 | SecurityGuard | SECURITY_GUARD | security/SecurityGuard | 📋 待迁移 |
| P1 | UrlSafetyChecker | URL_SAFETY_CHECKER | security/UrlSafetyChecker | 📋 待迁移 |
| P1 | ShellHooks | SHELL_HOOKS | security/ShellHooks | 📋 待迁移 |
| P1 | ModelManager | MODEL_MANAGER | models/ModelManager | 📋 待迁移 |
| P1 | ModelSelector | MODEL_SELECTOR | models/ModelSelector | 📋 待迁移 |
| P1 | MessageSanitizer | MESSAGE_SANITIZER | models/MessageSanitizer | 📋 待迁移 |
| P1 | ACPActivityTracker | ACP_ACTIVITY_TRACKER | ide/ACPActivityTracker | 📋 待迁移 |
| P1 | MessageProcessor | MESSAGE_PROCESSOR | shared/MessageProcessor | 📋 待迁移 |
| P1 | I18nManager | I18N_MANAGER | shared/I18nManager | 📋 待迁移 |
| P1 | PreferenceManager | PREFERENCE_MANAGER | memory/PreferenceManager | 📋 待迁移 |
| P1 | FileSystem | FILE_SYSTEM | io/FileSystem | 📋 待迁移 |
| P2 | SessionTokenQuotaManager | SESSION_TOKEN_QUOTA | harness/constraints/SessionTokenQuota | 📋 待迁移 |
| P2 | MCPToolBridge | MCP_TOOL_BRIDGE | harness/tools/registry/MCPToolBridge | 📋 待迁移 |
| P2 | LspClientManager | LSP_CLIENT_MANAGER | harness/lsp/LspClientManager | 📋 待迁移 |
| P2 | UnifiedContextBuilder | UNIFIED_CONTEXT_BUILDER | harness/context/UnifiedContextBuilder | 📋 待迁移 |
| P2 | SkillRegistry | SKILL_REGISTRY | skills/SkillRegistry | 📋 待迁移 |
| P2 | CronJobScheduler | CRON_SCHEDULER | cron/CronJobScheduler | 📋 待迁移 |
| P2 | ProfileTrendAnalyzer | PROFILE_TREND_ANALYZER | user/ProfileTrendAnalyzer | 📋 待迁移 |
| P2 | DeviceDiscovery | DEVICE_DISCOVERY | hardware/DeviceDiscovery | 📋 待迁移 |
| P3 | EvolutionOrchestrator | EVOLUTION_ENGINE | evolution/EvolutionOrchestrator | 📋 待迁移 |
| P3 | ImplicitFeedbackCollector | IMPLICIT_FEEDBACK_COLLECTOR | evolution/ImplicitFeedbackCollector | 📋 待迁移 |
| P3 | OptimizationResultDispatcher | OPTIMIZATION_RESULT_DISPATCHER | evolution/OptimizationResultDispatcher | 📋 待迁移 |
| P3 | OptimizationAdvisor | OPTIMIZATION_ADVISOR | evolution/decision/OptimizationAdvisor | 📋 待迁移 |
| P3 | DesktopActionExecutor | DESKTOP_ACTION_EXECUTOR | desktop/DesktopActionExecutor | 📋 待迁移 |
| P3 | DesktopMCPServer | DESKTOP_MCP_SERVER | desktop/DesktopMCPServer | 📋 待迁移 |
| P3 | WindowManager | WINDOW_MANAGER | desktop/WindowManager | 📋 待迁移 |
| P3 | SystemInput | SYSTEM_INPUT | desktop/SystemInput | 📋 待迁移 |
| P3 | UIElementParser | UI_ELEMENT_PARSER | desktop/ui/UIElementParser | 📋 待迁移 |
| P3 | ScreenCapture | SCREEN_CAPTURE | desktop/ScreenCapture | 📋 待迁移 |
| P3 | NormalizedCoordinateSystem | NORMALIZED_COORDINATES | desktop/NormalizedCoordinates | 📋 待迁移 |
| P3 | DesktopSkillRegistry | DESKTOP_SKILL_REGISTRY | desktop/DesktopSkillRegistry | 📋 待迁移 |

### 迁移规则

1. **新代码**：必须通过 `DIContainer.resolve(TOKEN)` 获取依赖，禁止直接调用 `getInstance()`
2. **旧代码迁移**：`getInstance()` 内部委托给 `DIContainer.resolve()`，外部 API 不变
3. **测试代码**：使用 `DIContainer.create()` 创建独立容器，通过 `registerValue()` 注入 mock
4. **V6.0 目标**：移除所有 `getInstance()` 静态方法，容器完全接管生命周期
