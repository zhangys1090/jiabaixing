"use strict";
/**
 * 对话历史管理器
 * 负责对话历史的存储、检索和持久化
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationHistoryManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const contracts_1 = require("../shared/contracts");
class ConversationHistoryManager {
    getStateFilePath(userId) {
        return path.join(process.cwd(), 'data', `conversation-state-${userId}.json`);
    }
    constructor(userId) {
        this.history = [];
        this.userId = 'default';
        this.saveDebounceTimer = null;
        this.userId = userId || 'default';
        this.stateFilePath = this.getStateFilePath(this.userId);
    }
    /**
     * 异步初始化：从文件加载对话历史
     * 构造函数不能为 async，因此将文件 I/O 延迟到 init()
     */
    async init() {
        await this.loadState();
    }
    addUserMessage(content) {
        this.addEntry('user', content);
    }
    addAssistantMessage(content) {
        this.addEntry('assistant', content);
    }
    addSystemMessage(content) {
        this.addEntry('system', content);
    }
    addEntry(role, content) {
        this.history.push({
            role,
            content,
            timestamp: new Date(),
        });
        if (this.history.length > ConversationHistoryManager.MAX_HISTORY) {
            this.history = this.history.slice(-ConversationHistoryManager.MAX_HISTORY);
        }
        this.scheduleSave();
    }
    addTurn(userContent, assistantContent) {
        this.addUserMessage(userContent);
        this.addAssistantMessage(assistantContent);
    }
    getRecent(count = 5) {
        return this.history.slice(-count);
    }
    getAll() {
        return [...this.history];
    }
    /**
     * 获取上一条助手消息内容（用于反馈分析）
     */
    getPreviousAssistantMessage() {
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].role === 'assistant') {
                return this.history[i].content;
            }
        }
        return null;
    }
    async clear() {
        this.history = [];
        await this.flushSave();
    }
    setHistory(history) {
        this.history = history.slice(-ConversationHistoryManager.MAX_HISTORY);
        this.scheduleSave();
    }
    /**
     * 调度保存（debounce）
     */
    scheduleSave() {
        if (this.saveDebounceTimer !== null) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(() => {
            this.saveState().catch((err) => {
                Logger_1.Logger.debug(`对话状态定时保存失败: ${err?.message}`, 'ConversationHistoryManager');
            });
            this.saveDebounceTimer = null;
        }, contracts_1.SYSTEM_CONSTANTS.HISTORY_SAVE_DEBOUNCE_MS);
        if (this.saveDebounceTimer.unref)
            this.saveDebounceTimer.unref();
    }
    /**
     * 立即保存（用于退出/清理场景）
     */
    async flushSave() {
        if (this.saveDebounceTimer !== null) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        await this.saveState();
    }
    getLength() {
        return this.history.length;
    }
    async saveState() {
        try {
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const state = {
                history: this.history.map((entry) => ({
                    ...entry,
                    timestamp: entry.timestamp instanceof Date
                        ? entry.timestamp
                        : new Date(entry.timestamp),
                })),
                lastUpdated: new Date().toISOString(),
                userId: this.userId,
            };
            await fs.promises.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
        }
        catch (error) {
            Logger_1.Logger.debug(`对话状态保存失败（非关键）: ${error.message}`, 'ConversationHistoryManager');
        }
    }
    async loadState() {
        try {
            if (fs.existsSync(this.stateFilePath)) {
                const raw = await fs.promises.readFile(this.stateFilePath, 'utf-8');
                const state = JSON.parse(raw);
                this.history = (state.history || []).map((entry) => ({
                    ...entry,
                    timestamp: new Date(entry.timestamp),
                }));
                this.userId = state.userId || this.userId;
                Logger_1.Logger.info(`💾 已恢复 ${this.history.length} 条对话历史`, 'ConversationHistoryManager');
            }
        }
        catch (error) {
            Logger_1.Logger.debug(`对话状态恢复失败（非关键）: ${error.message}`, 'ConversationHistoryManager');
        }
    }
    formatForLLM() {
        return this.history.map((entry) => ({
            role: entry.role,
            content: entry.content,
        }));
    }
}
exports.ConversationHistoryManager = ConversationHistoryManager;
ConversationHistoryManager.MAX_HISTORY = 20;
exports.default = ConversationHistoryManager;
