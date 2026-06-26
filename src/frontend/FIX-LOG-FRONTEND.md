# 前端 P0 问题修复日志

## 修复概要

### Issue 1: 响应超时 (RESPONSE_TIMEOUT_MS = 0)

**文件修改:**

- `src/components/ChatInterface/useChatConnection.ts` — 第20行: `const RESPONSE_TIMEOUT_MS = 0` → `const RESPONSE_TIMEOUT_MS = 60000`
- `src/components/ChatInterface/useChatActions.ts` — 第13行: `const RESPONSE_TIMEOUT_MS = 0` → `const RESPONSE_TIMEOUT_MS = 60000`

**效果:** 用户发送消息后，若60秒内无响应，自动触发 `markMessageFailed` 回调，显示"对方响应超时，可能正在忙碌"错误提示。用户可通过"重试"按钮重新发送。

### Issue 2: WebSocket error 不展示给用户

**文件修改:**

- `src/components/ChatInterface/useChatConnection.ts` — 新增 `onError` 回调（第205-223行）

**原因:** `useWebSocket` hook 的 `useWebSocket(options)` 接受 `onError` 回调，但 `useChatConnection` 未传递此参数，导致服务器错误消息仅被 `console.error()` 吞掉。

**修复方式:** 在 `useWebSocket` 调用中添加 `onError` 处理器，当收到 WebSocket 错误事件时：

1. 通过 `logFrontend` 记录错误到日志面板
2. 通过 `dispatch({ type: 'ADD_MESSAGE', ... })` 添加一条 `sender: 'system', status: 'error'` 的消息
3. 重置 `isRunning` 和 `isTyping` 状态

错误消息会以聊天气泡形式展示在 ChatWindow 中（现有 CSS 类 `.message-error-content`、`.error-icon`、`.error-text` 均有样式支持）。

### Issue 3: 对话历史持久化

**文件修改:**

- `src/contexts/ChatContext.tsx`

**现状分析:**
ChatContext 已有持久化机制（`STORAGE_KEY = 'jiabaixing_chat_messages'`）：

- `loadPersistedMessages()` — 初始化时从 localStorage 加载，过滤掉 `status: 'error'` 的消息
- `useEffect` 监听 `state.messages` 变化，每次变化时持久化（过滤掉 `sending`/`thinking`/`typing` 状态的中间消息）

**修复项:**

1. **添加 `streaming` 状态过滤** — 持久化时增加 `m.status !== 'streaming'`，防止流式输出中的部分内容被错误持久化
2. **CLEAR_MESSAGES 时清除 localStorage** — 当用户执行 `/clear` 命令清空对话时，同步 `localStorage.removeItem(STORAGE_KEY)`，防止刷新后重新加载旧消息
3. **修复 React Hooks 违规** — 将 `streamMessageIdRef` 从 `useEffect` 回调内部移动到组件顶层（`useRef` 不能在回调中调用，违反 `react-hooks/rules-of-hooks`）

### 额外修复

- `src/contexts/ChatContext.tsx` — 修复了 `useRef` 在 `useEffect` 回调中调用的问题（ESLint 错误），将 `streamMessageIdRef` 提升到组件作用域

## 构建验证

```
npm run build
```

构建成功，产出文件:

- `build/static/js/main.90994c99.js` (124.94 kB gzipped)
- `build/static/css/main.2076057c.css` (7.89 kB gzipped)

## 修改文件清单

| 文件                                                | 修改类型                                           |
| --------------------------------------------------- | -------------------------------------------------- |
| `src/components/ChatInterface/useChatConnection.ts` | 超时常量 + 新增 error 处理器                       |
| `src/components/ChatInterface/useChatActions.ts`    | 超时常量                                           |
| `src/contexts/ChatContext.tsx`                      | 持久化过滤 + CLEAR_MESSAGES 清除 + useRef 位置修复 |
