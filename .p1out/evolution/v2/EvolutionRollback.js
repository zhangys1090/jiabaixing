"use strict";
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
exports.EvolutionRollback = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../../utils/Logger");
class EvolutionRollback {
    constructor(checkpointDir = './.evolution-checkpoints') {
        this.checkpoints = new Map();
        this.MAX_CHECKPOINTS = 100;
        this.checkpointDir = path.resolve(checkpointDir);
        this.ensureCheckpointDir();
    }
    ensureCheckpointDir() {
        if (!fs.existsSync(this.checkpointDir)) {
            fs.mkdirSync(this.checkpointDir, { recursive: true });
        }
    }
    /**
     * 创建回滚检查点：为所有涉及文件创建快照
     */
    createCheckpoint(planId, actions) {
        const snapshot = {};
        for (const action of actions) {
            if (action.type === 'MODIFY_FILE' || action.type === 'DELETE_FILE') {
                const filePath = action.target.filePath ||
                    action.target;
                if (fs.existsSync(filePath)) {
                    try {
                        snapshot[filePath] = fs.readFileSync(filePath, 'utf-8');
                        Logger_1.Logger.debug(`Snapshot saved: ${filePath}`, 'EvolutionRollback');
                    }
                    catch (e) {
                        Logger_1.Logger.error(`Failed to snapshot ${filePath}`, e, 'EvolutionRollback');
                    }
                }
            }
        }
        const checkpoint = {
            id: `checkpoint-${planId}-${Date.now()}`,
            planId,
            timestamp: Date.now(),
            snapshot,
        };
        this.saveCheckpoint(checkpoint);
        this.checkpoints.set(checkpoint.id, checkpoint);
        if (this.checkpoints.size > this.MAX_CHECKPOINTS) {
            const oldestKey = this.checkpoints.keys().next().value;
            this.checkpoints.delete(oldestKey);
        }
        Logger_1.Logger.info(`💾 Checkpoint created: ${checkpoint.id} (${Object.keys(snapshot).length} files)`, 'EvolutionRollback');
        return checkpoint;
    }
    /**
     * 执行回滚
     */
    async rollback(checkpointId) {
        const checkpoint = this.checkpoints.get(checkpointId);
        if (!checkpoint) {
            return { success: false, error: `Checkpoint not found: ${checkpointId}` };
        }
        try {
            Logger_1.Logger.info(`⏪ Starting rollback to checkpoint: ${checkpointId}`, 'EvolutionRollback');
            for (const [filePath, originalContent] of Object.entries(checkpoint.snapshot)) {
                if (originalContent) {
                    fs.writeFileSync(filePath, originalContent, 'utf-8');
                    Logger_1.Logger.debug(`Rolled back: ${filePath}`, 'EvolutionRollback');
                }
                else {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        Logger_1.Logger.debug(`Rolled back delete: ${filePath}`, 'EvolutionRollback');
                    }
                }
            }
            Logger_1.Logger.info(`✅ Rollback completed: ${checkpointId}`, 'EvolutionRollback');
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error(`❌ Rollback failed: ${checkpointId}`, error, 'EvolutionRollback');
            return { success: false, error: error.message };
        }
    }
    /**
     * 获取指定计划的所有检查点 ID（按时间戳降序）
     */
    getCheckpointIdsByPlanId(planId) {
        return Array.from(this.checkpoints.values())
            .filter((cp) => cp.planId === planId)
            .sort((a, b) => b.timestamp - a.timestamp)
            .map((cp) => cp.id);
    }
    /**
     * 持久化检查点到磁盘
     */
    saveCheckpoint(checkpoint) {
        const checkpointPath = path.join(this.checkpointDir, `${checkpoint.id}.json`);
        fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    }
    /**
     * 从磁盘加载检查点
     */
    loadCheckpoint(checkpointId) {
        if (this.checkpoints.has(checkpointId)) {
            return this.checkpoints.get(checkpointId);
        }
        const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.json`);
        if (fs.existsSync(checkpointPath)) {
            const content = fs.readFileSync(checkpointPath, 'utf-8');
            const checkpoint = JSON.parse(content);
            this.checkpoints.set(checkpointId, checkpoint);
            return checkpoint;
        }
        return null;
    }
    /**
     * 清理旧检查点
     */
    cleanOldCheckpoints(daysToKeep = 7) {
        const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
        if (!fs.existsSync(this.checkpointDir))
            return;
        const files = fs.readdirSync(this.checkpointDir);
        let deleted = 0;
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const fullPath = path.join(this.checkpointDir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.mtime.getTime() < cutoff) {
                        fs.unlinkSync(fullPath);
                        deleted++;
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        if (deleted > 0) {
            Logger_1.Logger.info(`🧹 Cleaned up ${deleted} old checkpoints`, 'EvolutionRollback');
        }
    }
}
exports.EvolutionRollback = EvolutionRollback;
exports.default = EvolutionRollback;
