# CLI P0 修复日志

## 修复时间

2026-06-09

## 修复清单

### 1. IPC 超时太短 (P0)

- **文件**: `src/cli.ts`
- **行号**: 29
- **变更**: `IPC_TIMEOUT_MS = 5000` → `IPC_TIMEOUT_MS = 60000`
- **原因**: LLM 响应经常超过 5 秒，导致 IPC 超时后 fallback 到 HTTP，浪费一次请求。60s 与 HTTP 默认超时一致。

### 2. 空 catch 块 (P0)

为所有 IPC fallback 的空 catch 块添加了 `Logger.warn` 日志，涉及 27+ 处 catch 块，包括：

- `requestWithFallback` — `Logger.warn(\`IPC 请求 "${ipcMethod}" 失败，降级到 HTTP\`, 'RequestWithFallback')`
- `checkBackendHealth` — IPC fallback 增加日志
- `sendChatMessage` — IPC fallback 增加日志
- `handleSkillCommand` (REPL) — IPC fallback 增加日志
- `handleMemoryCommand` — IPC fallback 增加日志
- `handleEvolutionCommand` — IPC fallback 增加日志（包括 `/* ignore */` 块）
- `handleDesktopStatus` — IPC fallback 增加日志
- `handleAutomationMenu` — IPC fallback 增加日志（task list/add/toggle/execute/triggers/patterns）
- `handleChatGPTChat` — IPC fallback 增加日志
- `pipeMode` — IPC fallback 增加日志
- `askCommand` — IPC fallback 增加日志
- `subcommandMode` — IPC fallback 增加日志（skill/schedule/memory/evolution/context/search）
- `/web` 命令 — `catch {}` → `Logger.warn('打开浏览器失败', 'WebCommand')`
- 使用模式：`Logger.warn('IPC 不可用，降级到 HTTP', 'IPC')`

### 3. 子命令响应解析重复 (P0)

- **新增**: `extractResponse(data: unknown): string` 公共函数（位于 `IPC_TIMEOUT_MS` 之后）
- **支持格式**: `data.data?.response` > `data.response` > `data.message` > `data.text` > `data.output` > `data.error` > `JSON.stringify(data)`
- **替换了 7 处**重复的 `||` 链式解析：
  1. `sendChatMessage` IPC 路径
  2. `sendChatMessage` HTTP 路径
  3. `handleChatGPTChat` IPC 路径
  4. `pipeMode` 输出
  5. `askCommand` 输出
  6. `searchCommand` 输出
  7. (第7处原本是 `skill execute` 的 `data.output || data.error || JSON.stringify`，该模式被 `extractResponse` 统一覆盖)

### 验证

- `tsc --noEmit --skipLibCheck` 通过，src/cli.ts 无编译错误
- 所有非 node_modules 的 TS 错误计数为 0

## 变更文件

- `src/cli.ts` — 主要修改（IPC 超时、extractResponse、catch 日志）
- `FIX-LOG-CLI.md` — 本文件
