/**
 * SessionStore — 重导出壳 (Re-export Shell)
 *
 * §0.1 模块归属: 会话持久化核心已迁移至 Python
 * (`python/agent/api/sessions.py` + `python/agent/persistence/session_store.py`)。
 *
 * 本文件不含任何 `class` 实现，仅将 `SessionStoreBridge` 以 `SessionStore` 之名
 * 重导出，使既有 `import { SessionStore }` / `new SessionStore()` 调用零改动解析到
 * 桥接回退实现。类型契约 (SessionInfo / MessageInfo / SearchResult) 一并透传。
 *
 * @deprecated 生产路径应经 `PythonAgentBridge` 桥接 Python 后端；此类仅为本地回退。
 */

export * from './SessionStoreBridge';
export { SessionStoreBridge as SessionStore } from './SessionStoreBridge';
