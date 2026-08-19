"use strict";
/**
 * ACP 活动追踪器
 *
 * 桥接 EventBus 事件 → ACP 会话活动数据
 * 追踪文件变更、终端命令、工具调用，按 sessionId 聚合
 * 让 ACPServer 的 getFileDiffs/getTerminalCommands/getToolActivities 返回真实数据
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACPActivityTracker = void 0;
const Logger_1 = require("../utils/Logger");
class ACPActivityTracker {
    constructor() {
        this.fileDiffs = [];
        this.terminalCommands = [];
        this.toolActivities = [];
        this.MAX_PER_SESSION = 500;
        this.MAX_GLOBAL = 5000;
        this.cleanupInterval = setInterval(() => this.prune(), 10 * 60 * 1000);
        if (this.cleanupInterval.unref)
            this.cleanupInterval.unref();
    }
    static getInstance() {
        if (!ACPActivityTracker.instance) {
            ACPActivityTracker.instance = new ACPActivityTracker();
        }
        return ACPActivityTracker.instance;
    }
    static resetInstance() {
        if (ACPActivityTracker.instance) {
            clearInterval(ACPActivityTracker.instance.cleanupInterval);
            ACPActivityTracker.instance = null;
        }
    }
    trackFileDiff(sessionId, diff) {
        this.fileDiffs.push({ sessionId, diff, timestamp: Date.now() });
        this.enforceLimit('fileDiffs');
    }
    trackTerminalCommand(sessionId, command) {
        this.terminalCommands.push({ sessionId, command, timestamp: Date.now() });
        this.enforceLimit('terminalCommands');
    }
    trackToolActivity(sessionId, activity) {
        this.toolActivities.push({ sessionId, activity, timestamp: Date.now() });
        this.enforceLimit('toolActivities');
    }
    getSessionActivities(sessionId) {
        return {
            fileDiffs: this.fileDiffs
                .filter((t) => t.sessionId === sessionId)
                .map((t) => t.diff),
            terminalCommands: this.terminalCommands
                .filter((t) => t.sessionId === sessionId)
                .map((t) => t.command),
            toolActivities: this.toolActivities
                .filter((t) => t.sessionId === sessionId)
                .map((t) => t.activity),
        };
    }
    getFileDiffs(sessionId) {
        return this.fileDiffs
            .filter((t) => t.sessionId === sessionId)
            .map((t) => t.diff);
    }
    getTerminalCommands(sessionId) {
        return this.terminalCommands
            .filter((t) => t.sessionId === sessionId)
            .map((t) => t.command);
    }
    getToolActivities(sessionId) {
        return this.toolActivities
            .filter((t) => t.sessionId === sessionId)
            .map((t) => t.activity);
    }
    clearSession(sessionId) {
        this.fileDiffs = this.fileDiffs.filter((t) => t.sessionId !== sessionId);
        this.terminalCommands = this.terminalCommands.filter((t) => t.sessionId !== sessionId);
        this.toolActivities = this.toolActivities.filter((t) => t.sessionId !== sessionId);
    }
    getStats() {
        const sessions = new Set();
        for (const t of this.fileDiffs)
            sessions.add(t.sessionId);
        for (const t of this.terminalCommands)
            sessions.add(t.sessionId);
        for (const t of this.toolActivities)
            sessions.add(t.sessionId);
        return {
            fileDiffs: this.fileDiffs.length,
            terminalCommands: this.terminalCommands.length,
            toolActivities: this.toolActivities.length,
            sessions: sessions.size,
        };
    }
    enforceLimit(kind) {
        const arr = this[kind];
        if (arr.length > this.MAX_GLOBAL) {
            arr.splice(0, arr.length - this.MAX_GLOBAL);
        }
    }
    prune() {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        this.fileDiffs = this.fileDiffs.filter((t) => t.timestamp > cutoff);
        this.terminalCommands = this.terminalCommands.filter((t) => t.timestamp > cutoff);
        this.toolActivities = this.toolActivities.filter((t) => t.timestamp > cutoff);
        Logger_1.Logger.debug(`ACP 活动追踪器清理完成: ${this.fileDiffs.length} diffs, ${this.terminalCommands.length} commands, ${this.toolActivities.length} activities`, 'ACPActivityTracker');
    }
}
exports.ACPActivityTracker = ACPActivityTracker;
ACPActivityTracker.instance = null;
