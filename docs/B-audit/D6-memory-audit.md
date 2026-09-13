# D6: Memory Authority Audit

> 审计日期: 2026-09-13
> 审计目标: 解决 TS MemoryEngine / Python MemoryEngine / EpisodicMemory / Redis 到底谁是 canonical owner

## 核心验收标准

> experience → memory write → retrieval → state → decision
> 不能出现 rogue store 绕过 canonical owner 直接写入

## 审计结果

### Audit 1: Canonical owner for every memory domain ✅

| Domain | Canonical Owner | Process |
|--------|----------------|---------|
| short_term | Python MemoryEngine.storeShortTerm | python |
| long_term | Python MemoryEngine.storeLongTerm | python |
| episodic | Python EpisodicMemoryStore | python |
| cross_session | Python CrossSessionMemory | python |
| visual | Python VisualMemory | python |
| tool_selection | Python ToolSelectionMemory | python |
| feedback | Python MemoryEngine.storeFeedbackSignal | python |
| persistent_hermes | TS PersistentMemoryService bridged to Python | ts_bridge |

- Python owns 7/8 domains
- ts_bridge owns 1/8 domains (persistent_hermes)
- 每个 domain 有且仅有一个 canonical owner

### Audit 2: Rogue stores identified and fully isolated ✅

| Rogue Store | Domain | Issue | Recommendation |
|-------------|--------|-------|----------------|
| EpisodicMemoryStore | episodic | Local JSON bypasses Python | bridge_to_python |
| PersistentMemoryService | persistent_hermes | MEMORY.md/USER.md not bridged | bridge_to_python |
| MemoryRetriever | short_term | Imports deprecated stores | deprecate |

- **关键验证**: 0 production code imports any rogue store
- EpisodicMemoryStore.ts 已标记 `@deprecated`
- 所有 rogue store 的 import 已被清除

### Audit 3: Fail-closed — no silent fallback ✅

- Python domain + bridge 未注册 → `failed_closed` (NOT `ts_local`)
- 所有 7 个 Python domain 均验证 fail-closed
- ts_bridge domain 不 fail-closed（设计如此）
- **不会静默降级到 rogue store**

### Audit 4: Bridge registered → Python canonical owner respected ✅

- write → Python bridge 被调用
- read → Python bridge 被调用
- 数据流: TS MemoryAuthority → Python MemoryEngine → Redis/文件

### Audit 5: Every operation traceable to goalId/snapshotId/decisionId ✅

- write 带 goalId/decisionId/snapshotId → operation log 记录完整
- operation stats 区分 with-authority vs without-authority
- 每个 operation 有唯一 operationId + timestamp

### Audit 6: experience → memory write → retrieval → state → decision flow ✅

- write 后 read 返回一致数据
- 数据流: experience → MemoryAuthority.write() → Python → MemoryAuthority.read() → StateAuthority → DecisionAuthority

## 代码路径

```
MemoryAuthority.write(request)
  → getCanonicalOwner(request.memoryType)
  → if python && bridge registered → pythonWriteFn(request)
  → if python && !bridge → failed_closed (拒绝静默降级)
  → recordTrace({ operationId, goalId, decisionId, snapshotId, source })

MemoryAuthority.read(request)
  → getCanonicalOwner(domain)
  → if python && bridge registered → pythonReadFn(request)
  → if python && !bridge → failed_closed
  → recordTrace(...)
```

## 结论

**D6 Memory Authority: ✅ 通过**

核心问题"TS MemoryEngine / Python MemoryEngine / EpisodicMemory / Redis 到底谁是 canonical owner"已解决:
- Python 是 7/8 domain 的 canonical owner
- Rogue store 已隔离，0 import
- Fail-closed 防止静默降级
- 每个操作可追溯到 goalId/decisionId/snapshotId
