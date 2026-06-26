# FIX-LOG-GATEWAY-EXTEND.md — 网关能力扩展

## 问题

网关（GatewayBridge ↔ gatewayWorker）只能做一件事：对话（接收平台消息 → core.processInput → 返回）。其他40+ REST API 端点无法通过网关访问。

## 修复方案

采用方案A：扩展 IPC 协议。Worker 内用 `fetch()` 直接调后端 REST API。

### 修改的文件

#### 1. src/integration/gatewayWorker.ts (+1个IPC消息类型)

新增 `case 'apiRequest'` — 通用REST API代理：

- 接收 `{ endpoint, method, body }`
- Worker 内 `fetch(http://localhost:3111${endpoint})`
- 结果通过 IPC 返回 Bridge
- 15s 超时，失败返回 error

#### 2. src/integration/GatewayBridge.ts (+5个公开方法)

| 方法                           | 功能             | 内部调用                            |
| ------------------------------ | ---------------- | ----------------------------------- |
| `fetchApi(endpoint, options?)` | 通用REST API调用 | `sendRequest('apiRequest', ...)`    |
| `getServerHealth()`            | 获取健康状态     | `fetchApi('/api/health')`           |
| `getModelList()`               | 获取模型列表     | `fetchApi('/api/models')`           |
| `getEvolutionStatus()`         | 获取进化状态     | `fetchApi('/api/evolution/status')` |
| `getMemoryStats()`             | 获取记忆统计     | `fetchApi('/api/memory/stats')`     |

### 架构变化

```
之前:  平台消息 → gatewayWorker → core.processInput() → 对话响应
      其他API → 无法通过网关访问

现在:  平台消息 → gatewayWorker → core.processInput() → 对话响应
      REST API → gatewayWorker → fetch(localhost:3111/api/...) → 数据返回
                              ↕ IPC
                   GatewayBridge.fetchApi() (供CLI/其他模块调用)
```

### 验证

- npm run build: 0 errors ✅
- Worker 不存活时 fetchApi 返回 null（安全降级）
