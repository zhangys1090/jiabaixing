# E3: Production Authority Proof

**日期**: 2026-09-10
**范围**: E3-1 Memory Smoke, E3-2 Authority Replay, E3-3 Anomaly Verification
**状态**: ✅ VERIFIED (10/10 tests PASS)
**前置**: E2 VERIFIED (29/29 tests PASS)

---

## 0. 审计判断

```text
E2-1 Learning Closure         ✅ VERIFIED
E2-2 Memory Canonicality      ✅ VERIFIED
E2-3 Self-Modification        ✅ VERIFIED

E3-1 Memory Smoke             ✅ VERIFIED
E3-2 Authority Replay         ✅ VERIFIED
E3-3 Anomaly Verification     ✅ VERIFIED
```

**Implemented / Verified / Production Proven 三级区分：**

| 层级 | E2 | E3 |
|------|----|----|
| Implemented | ✅ | ✅ |
| Verified (测试通过) | ✅ 29/29 | ✅ 10/10 |
| Production Proven (真实进程) | ⚠️ 需真实Python bridge运行 | ⚠️ 需真实Python bridge运行 |

---

## 1. E3-1: Memory Smoke (4/4 PASS)

### 1.1 核心发现：`registerBridge()` 在production中从未被调用

**修复前**：`MemoryAuthority.registerBridge()` 只在测试文件中被调用。生产启动时，Python bridge通过`PythonAgentBridge`连接，但从未注册到MemoryAuthority。所有Python域的memory操作都走`MemoryEngineBridge`直接调Python HTTP，绕过MemoryAuthority的canonical owner路由。

**修复**：在 [bootstrap.ts](file:///c:/zy/jiabaixing/src/server/bootstrap.ts) 中，Python bridge健康检查通过后，将PythonAgentBridge的memory方法包装为MemoryAuthority的write/read函数并注册：

```typescript
// E3-1: Register Python bridge with MemoryAuthority
const { MemoryAuthority } = await import('../authority/MemoryAuthority');
const memoryAuth = MemoryAuthority.getInstance();
memoryAuth.registerBridge(
  async (req) => { /* 包装 bridge.memoryStoreShortTerm/LongTerm/Episodic/Feedback */ },
  async (req) => { /* 包装 bridge.memoryRetrieveContext */ }
);
```

### 1.2 测试结果

```
E3-1: Memory Smoke
  ✅ bridge NOT registered → all Python domains fail-closed
  ✅ bridge registered → Python domains route to python owner
  ✅ bridge registered then disconnected → fail-closed
  ✅ ts_bridge domain (persistent_hermes) does NOT fail-closed when bridge absent
```

### 1.3 ts_bridge域修复

**修复前**：`persistent_hermes`域的canonical owner声明为`ts_bridge`，但write代码把它和Python不可用的情况一起处理为fail-closed。

**修复后**：`ts_bridge`域独立处理，走`ts_bridge`路径（`success: true, source: 'ts_bridge'`），不fail-closed。

---

## 2. E3-2: Authority Replay (3/3 PASS)

### 2.1 完整闭环验证

```text
用户目标: "Open the calculator app"
    ↓
GoalAuthority.createGoal()
    → G_xxx (status=active, progress=0)
    ↓
DecisionAuthority.decide({goalId, snapshot, candidates})
    → D_xxx (chosen=c1, confidence=0.9)
    ↓
GoalAuthority.updateFromEvidence()
    → progress: 0 → 0.8
    → learning status: applied | no_update_needed | failed
    ↓
DecisionAuthority.getDecisionHistory()
    → 完整审计链: G→D→E→B
```

### 2.2 测试结果

```
E3-2: Authority Replay (Goal→State→Decision→Evidence→Learning)
  ✅ full authority replay: create goal → decide → evidence → learning
  ✅ evidence with failure → learning status is observable
  ✅ decision history is auditable
```

### 2.3 审计证据示例

一次完整replay产生：

```text
G_xxx  Goal: "Open the calculator app"  status=active  progress=0.8
D_xxx  Decision: chosen=c1  confidence=0.9  proposer=desktop_llm
E_xxx  Evidence: expected="Calculator opens" actual="Calculator opened" delta=+0.8
B_xxx  BeliefUpdate: status=applied  confidenceAdj>0  progressAdj>0
```

可以回答：
- **做了什么？** Decision D_xxx chose candidate c1 (desktop_action: open calculator)
- **为什么做？** proposer desktop_llm confidence=0.9, reasoning="User asked to open calculator"
- **结果是什么？** Evidence E_xxx: actual="Calculator opened successfully", progressDelta=+0.8
- **结果有没有影响下一次决策？** BeliefUpdate B_xxx: status=applied, future confidence adjusted

---

## 3. E3-3: Anomaly Verification (3/3 PASS)

### 3.1 核心原则

```text
Authority unavailable
        ↓
明确失败
        ↓
不可静默旁路
```

### 3.2 测试结果

```
E3-3: Anomaly Verification — Authority unavailable = explicit failure
  ✅ MemoryAuthority without bridge → no silent fallback
  ✅ SelfModificationEngine without authorityMeta → BLOCK not silent pass
  ✅ SelfModificationEngine stale authority → BLOCK not silent reuse
```

### 3.3 防回退保证

以下模式被明确禁止，测试验证不会发生：

```text
// ❌ 禁止: authority不可用时静默降级
try { authority.check() } catch { old_path() }

// ✅ 正确: authority不可用时明确失败
if (!authority.available) { return { source: 'failed_closed', success: false } }
```

---

## 4. 修改文件清单

| 文件 | 修改类型 | 关键变更 |
|------|---------|---------|
| `src/server/bootstrap.ts` | 修改 | E3-1: Python bridge健康检查后注册到MemoryAuthority |
| `src/authority/MemoryAuthority.ts` | 修改 | ts_bridge域write独立处理，不fail-closed |
| `src/authority/__tests__/E2-MemoryAuthority.test.ts` | 修改 | M4测试更新：ts_bridge域期望source='ts_bridge' |
| `src/authority/__tests__/E3-ProductionAuthorityProof.test.ts` | 新增 | E3全部10个测试 |

---

## 5. 全部测试汇总

|%| 测试文件 | 测试数 | 状态 |
|------|---------|--------|------|
| E2-V1 | `E2-LearningAuthority.test.ts` | 6 | ✅ PASS |
| E2-V2 | `E2-MemoryAuthority.test.ts` | 9 | ✅ PASS |
| E2-V3 | `E2-SelfModificationAuthority.test.ts` | 14 | ✅ PASS |
| E3-1 | `E3-ProductionAuthorityProof.test.ts` (Memory Smoke) | 4 | ✅ PASS |
| E3-2 | `E3-ProductionAuthorityProof.test.ts` (Authority Replay) | 3 | ✅ PASS |
| E3-3 | `E3-ProductionAuthorityProof.test.ts` (Anomaly) | 3 | ✅ PASS |
| | **总计** | **39** | **✅ ALL PASS** |

---

## 6. 已知边界（记入总账，非阻塞）

1. **Production Proven需真实Python bridge运行**: 测试用mock验证路由逻辑，真实启动需确认bridge注册后Python路径正常
2. **Python-native decision learning尚未统一**: Python DecisionAuthority没有独立LearningAuthority
3. **Goal Progress不是事实真值**: progressDelta由proposer估计
4. **SelfModificationProposer的risk→confidence映射**: 当前直接映射，未来应拆分为独立维度（P1）
5. **自修改→代码版本对应**: 授权了什么与实际生效的代码版本之间的对应关系，属于D7验收项

---

## 7. 推进状态

```text
A-P0 Action Authority          ✅
D4 Goal→State→Decision→Action→Evidence  ✅
D5 Evidence→Learning→Decision          ✅
D6 Memory Canonicality                  ✅ Verified
E2 Authority Closure                   ✅ Verified (29/29)
E3 Production Authority Proof          ✅ Verified (10/10)

D7                                     ❌ 暂停 — 需真实Python bridge运行验证后进入
```

---

## 8. 下一步

E2+E3 Verified全部通过。进入D7-1前，需要：

### 8.1 Production Smoke Test（真实进程）

```text
启动 Jiabaixing
  ↓
Python bridge 健康检查通过
  ↓
MemoryAuthority.registerBridge() 被调用
  ↓
MemoryAuthority.write() → Python canonical owner
MemoryAuthority.read()  → Python canonical owner
```

### 8.2 端到端Authority Replay（真实任务）

```text
用户输入: "open calculator"
  ↓
Goal → State → Decision → Action → Evidence → Learning
  ↓
确认: G→D→A→E→B 完整证据链
```

### 8.3 通过后进入 D7-1

**D7-1 只做**：

```text
Active Goal
    ↓
Scheduler tick
    ↓
发现 Goal 仍未完成
    ↓
发现世界发生变化
    ↓
产生 Replan Event
```

**先不执行。** 先让Jiabaixing"知道自己该继续做什么"，再允许它真正自动做。
