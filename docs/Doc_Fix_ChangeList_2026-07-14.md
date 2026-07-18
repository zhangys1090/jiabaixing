# 精确改动清单 · 类别四（文档过期）+ 类别五（测试假绿）

> 日期: 2026-07-14
> 范围: 仅 ARCHITECTURE.md 与 1 个测试文件，**零/低风险**
> 状态: **待你确认后我才动手**（本轮只出清单，不改）
> 依据: `docs/Doc_Derived_Audit_Report_2026-07-14.md` + 实地 grep 复核
> 复核中纠正的 2 处报告不精确:
>
> - `TTSProviderRegistry` 并非"Python 端组件"——TS/Python 两端均无此类名，TTS 以 `voice_mode_tool` 等形态存在。
> - D-storage 的"ChromaDB 未实例化"不准确——`ChromaVectorDatabase` 在 `src/memory/VectorDatabase.ts:60` 有实例化（它本身属类别一 TS 违规）。故 L417 不能断言 ChromaDB 已死。

---

## 类别四 · 文档过期 — 全部在 `ARCHITECTURE.md`（5 大项，8 处行级改动）

### 4.1 `TTSProviderRegistry` 失效（2 处）

**证据**: `grep "TTSProviderRegistry"` 在 `src/interaction/SpeechSynthesizer.ts` 与 `python/**/*.py` 均 **0 命中**。TTS 真实实现在 Python `python/agent/tools/voice_mode_tool.py` 等。

| 行  | 当前文本                                                                                                       | 建议改为                                                                                                          | 理由                             |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 167 | `\| TTS多提供商       \| ✅   \| \`SpeechSynthesizer\` + TTSProviderRegistry \|`                               | `\| TTS多提供商       \| ✅   \| Python \`python/agent/tools/voice_mode_tool.py\`（TS 已不承载 TTS 注册）\|`      | 类名不存在，指向 Python 真实实现 |
| 347 | `\| TTS Provider  \| \`src/interaction/SpeechSynthesizer.ts\` \| 有 (内部 TTSProviderRegistry) \| 代码注册 \|` | `\| TTS Provider  \| Python \`python/agent/tools/voice_mode_tool.py\` \| 有（TTS 已迁 Python） \| Python 装配 \|` | 该 TS 文件无此 registry，属虚构  |

### 4.2 `PromptCacheManager` 指向已删 TS 文件（4 处）

**证据**: `src/models/PromptCacheManager.ts` **已删除**（ls 确认）；Python `python/agent/llm/prompt_cache.py` 含 `PromptCacheManager`（存在）。

| 行  | 当前文本                                                                                                     | 建议改为                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 168 | `\| Prompt缓存        \| ✅   \| \`PromptCacheManager\` \|`                                                  | `\| Prompt缓存        \| ✅   \| Python \`python/agent/llm/prompt_cache.py\` \|`                                  |
| 240 | `\| 冻结快照保持 system prompt 稳定 \| PromptCacheManager ✅                 \| 已对齐                   \|` | `\| 冻结快照保持 system prompt 稳定 \| Python \`prompt_cache.py\` ✅ \| 已对齐 \|`                                |
| 301 | `\| \`PromptCacheManager\` \| \`src/models/PromptCacheManager.ts\` \| 包装 SQLite \| prompt 智能缓存 \|`     | `\| \`PromptCacheManager\` \| \`python/agent/llm/prompt_cache.py\` \| 包装 SQLite \| prompt 智能缓存（Python）\|` |
| 394 | `6. **✅ Prompt 缓存** — \`PromptCacheManager\` 智能缓存`                                                    | `6. **✅ Prompt 缓存** — Python \`prompt_cache.py\` 智能缓存`                                                     |

### 4.3 §3.4 缓存路径整体失效（目录树 + 表 + 建议小节）

**证据**: 4 个 TS 缓存文件 `SqliteCacheStore.ts` / `PromptCacheManager.ts` / `PromptCache.ts` / `RedisCache.ts` **全部已删**（ls 确认）。`LLMResponseCache.ts` **仍在**（`src/models/LLMResponseCache.ts`，被 4 个 Provider import）。

| 行           | 当前文本                                                                                           | 建议改为                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 99-100       | `│   ├── {PromptCache,LLMResponseCache,`<br>`│   │    SqliteCacheStore,RedisCache}.ts  ← 4 种缓存` | `│   ├── LLMResponseCache.ts  ← 仅存的 TS 缓存（其余已迁 python/agent/llm）`                                                                                                                                                                                                                                                                                              |
| 300-302 表   | `SqliteCacheStore` / `PromptCacheManager` / `RedisCache` 三行均指向 `src/models/*.ts`（已删）      | 三行改为 Python 路径：<br>`\| \`SqliteCacheStore\` \| \`python/agent/llm/\`（已迁） \| SQLite \| 持久化值存储（Python）\|`<br>`\| \`PromptCacheManager\` \| \`python/agent/llm/prompt_cache.py\` \| 包装 SQLite \| prompt 智能缓存（Python）\|`<br>`\| \`RedisCache\` \| \`python/agent/\`（已迁） \| Redis \| 通用缓存（Python）\|`<br>（`LLMResponseCache` 行保留不动） |
| 307-311 建议 | 引用 `RedisCache`/`SqliteCacheStore`/`PromptCacheManager` 作为 ICache 设计                         | 改写为："上述缓存均已迁 Python；TS 仅保留 `LLMResponseCache`（内存）作为轻量 fallback"                                                                                                                                                                                                                                                                                    |

### 4.4 宏观存储描述（1 处）

**证据**: 全仓仅 L417 提 `ChromaDB`；运行实为 Python 中心 SQLite/FTS5。`ChromaVectorDatabase` 在 `src/memory/VectorDatabase.ts:60` 仍有实例化（属类别一 TS 违规，非"已死"）。

| 行  | 当前文本                              | 建议改为                                                                             |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| 417 | `6. **SQLite + ChromaDB 双向量存储**` | `6. **SQLite + FTS5 全文检索 + 向量存储（Python 中心；ChromaDB 仅 TS 遗留向量层）**` |

### 4.5 端口描述缺失（1 处）

**证据**: L14 只写 3111；实际为 TS 网关 3111 + Python 后端 3112（`AGENT_BACKEND=python`）。

| 行  | 当前文本                                                              | 建议改为                                                                                                                     |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 14  | `\| 服务端   \| \`src/main.ts\` \| Express + WebSocket，端口 3111 \|` | 新增一行：`\| Python 后端 \| \`python/\`（FastAPI） \| 端口 3112，\`AGENT_BACKEND=python\` 启用 \|`（或在该单元格补注 3112） |

---

## 类别五 · 测试假绿 — 1 处

**位置**: `tests/e2e/HermesFeatures.e2e.test.ts:129`
**当前**:

```ts
test.skip('19. LLM 能力探测集成到进化编排器（已迁移到 Python）', async () => {});
```

**问题**: 空体 `test.skip` 存根，零断言，冒充"已覆盖/已迁移"——属假绿。

**两个选项（需你定）**:

- **选项 A（推荐，低风险）删除存根**：直接删除第 129 行。理由：该功能已迁 Python，TS 端无等价可测逻辑，留空 skip 是噪音+假绿。
- **选项 B（补真断言）**：改为对"Python 端迁移后等价行为"的真实断言。但需跨进程（起 Python 后端 + `AGENT_BACKEND=python`），成本高，建议待有稳定 Python e2e harness 后再补。

---

## 改动后的验证方式

改完复跑探针，预期 FAIL 数从 21 降到 15（类别四 5 + 类别五 1 = 6 条转 PASS）：

```bash
node scripts/doc-derived-audit.mjs
```

若某条仍 FAIL，说明清单措辞与探针判定口径不一致，需回看探针而非强行改文档。

## 不动的部分（本轮明确排除）

- 类别一/二/三 涉及代码的改动（MCPServerManager 迁移、调用方切换、死代码接线）— 高风险，需单独排期。
- 恒真断言守卫 `check-no-tautology-tests.mjs` 已 PASS，无需动。
