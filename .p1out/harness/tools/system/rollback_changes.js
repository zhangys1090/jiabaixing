"use strict";
/**
 * Harness Tool: rollback_changes - 回滚文件到之前版本
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
exports.ROLLBACK_CHANGES_DEF = void 0;
exports.createRollbackChangesExecutor = createRollbackChangesExecutor;
const fs = __importStar(require("fs"));
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.ROLLBACK_CHANGES_DEF = {
    name: 'rollback_changes',
    description: '回滚文件到之前的版本。适用场景：用户对修改不满意想要撤销、修改后发现问题需要恢复。不适用：没有修改历史的文件。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        file_path: {
            type: 'string',
            description: '要回滚的文件路径',
        },
        steps: {
            type: 'number',
            description: '回滚步数，默认1步（即上一次修改）',
            default: 1,
        },
    },
    requiredParams: ['file_path'],
    requiredPermissions: [types_1.Permission.FILE_WRITE],
    riskLevel: 'medium',
    idempotent: false,
    timeout: 10000,
};
/** 创建 rollback_changes 执行器 */
function createRollbackChangesExecutor(deps) {
    return async (params, context) => {
        const filePath = String(params.file_path || '');
        const steps = Number(params.steps) || 1;
        const traceId = context?.traceId || '';
        if (!filePath) {
            return {
                success: false,
                output: null,
                error: '请提供文件路径',
                duration: 0,
                validated: false,
            };
        }
        if (steps < 1) {
            return {
                success: false,
                output: null,
                error: '回滚步数必须大于0',
                duration: 0,
                validated: false,
            };
        }
        // 优先使用检查点回滚整个工作目录
        if (deps.checkpointService) {
            try {
                const checkpoints = deps.checkpointService.listCheckpoints();
                if (checkpoints.length >= steps) {
                    const target = checkpoints[steps - 1];
                    const rolledBack = await deps.checkpointService.rollback(target.id);
                    if (rolledBack) {
                        Logger_1.Logger.info(`↩️ 通过检查点回滚工作目录: ${target.label} (${target.id})`, 'RollbackChanges');
                        void EventBus_1.EventBus.emit('file_rollback', {
                            traceId,
                            filePath,
                            success: true,
                            timestamp: new Date().toISOString(),
                        });
                        return {
                            success: true,
                            output: `已通过检查点回滚工作目录到 ${steps} 步前的状态\n检查点: ${target.label}`,
                            duration: 0,
                            validated: false,
                        };
                    }
                    // 检查点回滚失败，回退到历史记录模式
                    Logger_1.Logger.warn('检查点回滚失败，回退到历史记录模式', 'RollbackChanges');
                }
            }
            catch (cpErr) {
                Logger_1.Logger.warn(`检查点回滚异常，回退到历史记录模式: ${cpErr.message}`, 'RollbackChanges');
            }
        }
        const history = await deps.getHistory(filePath);
        if (!history || history.length === 0) {
            return {
                success: false,
                output: null,
                error: `文件 ${filePath} 没有修改历史，无法回滚`,
                duration: 0,
                validated: false,
            };
        }
        if (steps > history.length) {
            return {
                success: false,
                output: null,
                error: `回滚步数 ${steps} 超过历史记录数量 ${history.length}`,
                duration: 0,
                validated: false,
            };
        }
        try {
            const targetEntry = history[steps - 1];
            fs.writeFileSync(filePath, targetEntry.content, 'utf-8');
            await deps.removeHistory(filePath, steps);
            Logger_1.Logger.info(`↩️ 回滚文件: ${filePath} 到 ${steps} 步前的版本`, 'RollbackChanges');
            void EventBus_1.EventBus.emit('file_rollback', {
                traceId,
                filePath,
                success: true,
                timestamp: new Date().toISOString(),
            });
            return {
                success: true,
                output: `已将 ${filePath} 回滚到 ${steps} 步前的版本\n修改内容: ${targetEntry.description}`,
                duration: 0,
                validated: false,
            };
        }
        catch (err) {
            Logger_1.Logger.error(`回滚失败: ${filePath}`, err, 'RollbackChanges');
            return {
                success: false,
                output: null,
                error: `回滚失败: ${err.message}`,
                duration: 0,
                validated: false,
            };
        }
    };
}
