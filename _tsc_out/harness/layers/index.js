"use strict";
/**
 * Harness Layers — 配置驱动组合层
 *
 * Phase 2 核心模块：
 * - interfaces: 各层标准化接口
 * - HarnessConfigManager: 配置文件解析与管理
 * - HarnessComposer: 运行时层组合器
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HarnessComposer = exports.HarnessConfigManager = void 0;
var HarnessConfigManager_1 = require("./HarnessConfigManager");
Object.defineProperty(exports, "HarnessConfigManager", { enumerable: true, get: function () { return HarnessConfigManager_1.HarnessConfigManager; } });
var HarnessComposer_1 = require("./HarnessComposer");
Object.defineProperty(exports, "HarnessComposer", { enumerable: true, get: function () { return HarnessComposer_1.HarnessComposer; } });
