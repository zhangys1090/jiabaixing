# FIX-LOG-CLI-EXTEND.md — CLI能力扩展

## 修改内容

### 服务端: src/server/bootstrap.ts (+12个IPC方法)

| IPC方法              | 对应REST端点                  | 功能          |
| -------------------- | ----------------------------- | ------------- |
| model.list           | GET /api/models               | 模型列表      |
| model.switch         | POST /api/models/switch       | 切换模型      |
| memory.store         | POST /api/memory/store        | 存储记忆      |
| mcp.servers          | GET /api/mcp/servers          | MCP服务器列表 |
| security.report      | GET /api/security/report      | 安全报告      |
| security.logs        | GET /api/security/logs        | 安全日志      |
| performance.snapshot | GET /api/performance/snapshot | 性能快照      |
| system.resources     | GET /api/system/resources     | 系统资源      |
| system.integrity     | GET /api/system/integrity     | 系统完整性    |
| conversations.list   | GET /api/conversations        | 对话历史      |
| docs.index           | GET /api/docs/index           | 文档索引      |
| debug.weights        | GET /api/debug/weights        | 调试权重      |

### CLI: src/cli.ts (+7个新子命令组)

| 子命令          | 子动作               | 使用方式                                                 |
| --------------- | -------------------- | -------------------------------------------------------- |
| `model`         | list, switch         | `jiabaixing model list`, `jiabaixing model switch gpt-4` |
| `security`      | report, logs         | `jiabaixing security report`, `jiabaixing security logs` |
| `performance`   | snapshot             | `jiabaixing performance snapshot`                        |
| `mcp`           | servers              | `jiabaixing mcp servers`                                 |
| `system`        | resources, integrity | `jiabaixing system resources`                            |
| `conversations` | list                 | `jiabaixing conversations list`                          |
| `docs`          | index                | `jiabaixing docs index`                                  |

### 通信架构

```
CLI → IPC优先 (Named Pipe/Unix Socket) → 后端 (bootstrap.ts handleIpcRequest)
      失败自动降级 → HTTP REST         → 后端 (Express routes)
```

编译: 0 errors ✅
