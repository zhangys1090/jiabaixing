"use strict";
/**
 * A2A 协议 TS 薄壳统一出口。
 *
 * 架构定位（AGENTS.md §0.1）：A2A 协议**主实现在 Python**（`agent/a2a/`），
 * 本包仅提供：
 *   - `registerA2ARoutes`：把 `/a2a/*` HTTP 入口透明转发到 Python 后端；
 *   - `A2AClient`：TS 侧出站调用远端 A2A Agent 的薄封装；
 *   - 类型：与 Python `agent/a2a/types.py` 一一对应的 TS 类型。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./types"), exports);
__exportStar(require("./A2ARouter"), exports);
__exportStar(require("./A2AClient"), exports);
