/**
 * A2A 协议 TS 薄壳统一出口。
 *
 * 架构定位（AGENTS.md §0.1）：A2A 协议**主实现在 Python**（`agent/a2a/`），
 * 本包仅提供：
 *   - `registerA2ARoutes`：把 `/a2a/*` HTTP 入口透明转发到 Python 后端；
 *   - `A2AClient`：TS 侧出站调用远端 A2A Agent 的薄封装；
 *   - 类型：与 Python `agent/a2a/types.py` 一一对应的 TS 类型。
 */

export * from './types';
export * from './A2ARouter';
export * from './A2AClient';
