"use strict";
/**
 * Action 统一抽象模块统一导出
 *
 * 编排层只需：
 *   import { getActionDispatcher } from '../harness/action';
 *   const result = await getActionDispatcher().dispatch({ channel: 'desktop', desktopAction, verify });
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
__exportStar(require("./verify/VerificationBridge"), exports);
__exportStar(require("./channels/ToolChannel"), exports);
__exportStar(require("./channels/DesktopChannel"), exports);
__exportStar(require("./channels/McpChannel"), exports);
__exportStar(require("./ActionDispatcher"), exports);
