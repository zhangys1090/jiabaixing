# FIX-LOG-GATEWAY: P0 网关问题修复

## 问题概述

修复家百星网关的 P0 问题: LLM异常时向用户回显错误消息，以及相关的静默catch排查和消息排队提示。

## 问题1: LLM异常时用户无反馈 (P0)

**文件**: `src/integration/IntegrationManager.ts`

**修复前**: `handleIncomingMessage()` 的 `catch` 块 (line 459-464) 只调用 `Logger.error()`，不向用户回复任何消息。用户以为消息发送成功但没有收到回复。

**修复后**: 在 catch 块中嵌套 try-catch，调用 `sendMessage()` 向用户回显:

```
try {
  await this.sendMessage({
    platform: message.platform,
    message: '处理出错，请稍后再试 🙇',
    to: message.from || '',
  });
} catch (sendError) {
  Logger.error('发送错误提示消息失败', sendError as Error, 'IntegrationManager');
}
```

**变更行**: ~475-494

---

## 问题2: 排查所有 catch 块

扫描 `src/integration/` 下所有 catch 块，确认每个都有日志或用户反馈:

| 文件                                   | catch位置       | 原始状态                | 修复                                                                              |
| -------------------------------------- | --------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `IntegrationManager.ts` L459           | 主处理流程      | 已有 Logger.error       | ✅ 已存在日志                                                                     |
| `IntegrationManager.ts` L455 (catch e) | 进化数据记录    | 已有 Logger.debug       | ✅ 非重要分支，debug级别合理                                                      |
| `IntegrationManager.ts` L274           | connectPlatform | 已有 Logger.error       | ✅                                                                                |
| `IntegrationManager.ts` L618           | deliverWebhook  | 已有 Logger.warn        | ✅                                                                                |
| **`WeChatQRAdapter.ts` L324**          | **关闭浏览器**  | **`catch {}` 完全静默** | **新增 `Logger.warn('关闭浏览器时出错', 'WeChatQRAdapter')`**                     |
| **`TelegramAdapter.ts` L139**          | **删除Webhook** | **`catch {}` 完全静默** | **新增 `Logger.warn('删除 Telegram Webhook 时出错（忽略）', 'TelegramAdapter')`** |
| BaseIntegrationAdapter.ts L82          | 消息处理器循环  | 已有 Logger.error       | ✅                                                                                |
| 各Adapter的connect/sendMessage         | 标准错误处理    | 已有 Logger.error       | ✅                                                                                |

**修复**: 两个静默 catch 块均已添加 Logger.warn

---

## 问题3: 消息排队无提示

**文件**: `src/integration/IntegrationManager.ts`

**修复前**: `acquireMessageSlot()` 在并发槽满时静默入队，用户无任何反馈。

**修复后**: 修改 `acquireMessageSlot(message?)` 方法，接受可选的 `IncomingMessageEvent` 参数。当没有空闲槽位时，先尝试发送排队提示:

```
try {
  await this.sendMessage({
    platform: message.platform,
    message: '正在排队，请稍候 ⏳',
    to: message.from || '',
  });
} catch (sendError) {
  Logger.error('发送排队提示消息失败', sendError as Error, 'IntegrationManager');
}
```

调用处改为 `await this.acquireMessageSlot(message)` 传入消息上下文。

**防死循环**: sendMessage 调用嵌套了 try-catch，即使 sendMessage 抛异常也不会影响排队逻辑继续入队。

---

## 验证

- `npx tsc --noEmit` ✅ 编译通过，零错误
- 所有 sendMessage 调用均有内部 try-catch，不会引入死循环
- 排队通知只在真正入队时触发一次，不会重复通知
- 错误回显在 catch 块内，不会影响 finally 中的 releaseMessageSlot

## 修改文件清单

1. **`src/integration/IntegrationManager.ts`** — 3处修改:
   - `acquireMessageSlot()`: 增加 message 参数 + 排队通知
   - `handleIncomingMessage()`: 调用处传递 message
   - `handleIncomingMessage()` catch 块: 向用户发送错误提示

2. **`src/integration/adapters/WeChatQRAdapter.ts`** — 1处修改:
   - 静默 `catch {}` → `Logger.warn`

3. **`src/integration/adapters/TelegramAdapter.ts`** — 1处修改:
   - 静默 `catch {}` → `Logger.warn`

4. **`FIX-LOG-GATEWAY.md`** — 本文件
