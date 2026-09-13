"use strict";
/**
 * TrajectoryDatabase — 重导出壳 (Re-export Shell)
 *
 * §0.1 模块归属: 轨迹持久化核心已迁移至 Python
 * (`python/agent/persistence/trajectory.py` + `python/agent/api/trajectory.py`)。
 *
 * 本文件不含任何 `class` 实现，仅将 `TrajectoryDatabaseBridge` 以 `TrajectoryDatabase`
 * 之名重导出，使既有 `import { TrajectoryDatabase }` / `new TrajectoryDatabase()` 调用
 * 零改动解析到桥接回退实现。所有记录类型契约 (ExecutionRecord 等) 一并透传。
 *
 * @deprecated 生产路径应经 `PythonAgentBridge` 桥接 Python 后端；此类仅为本地回退。
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
exports.TrajectoryDatabase = void 0;
__exportStar(require("./TrajectoryDatabaseBridge"), exports);
var TrajectoryDatabaseBridge_1 = require("./TrajectoryDatabaseBridge");
Object.defineProperty(exports, "TrajectoryDatabase", { enumerable: true, get: function () { return TrajectoryDatabaseBridge_1.TrajectoryDatabaseBridge; } });
