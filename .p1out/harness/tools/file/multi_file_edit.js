"use strict";
/**
 * Harness Tool: multi_file_edit - 多文件原子修改
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MULTI_FILE_EDIT_DEF = void 0;
exports.createMultiFileEditExecutor = createMultiFileEditExecutor;
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.MULTI_FILE_EDIT_DEF = {
    name: 'multi_file_edit',
    description: '同时修改多个文件，保持修改的原子性。适用场景：重构涉及多个文件、添加功能需要修改多处、API变更需要同步更新。不适用：单文件修改（用 incremental_edit）。',
    category: types_1.ToolCategory.FILE,
    parameters: {
        files: {
            type: 'array',
            description: '文件修改列表，每项包含 {path, edits: [{search, replace, description}]}',
            items: {
                type: 'object',
                description: '文件修改项',
                properties: {
                    path: { type: 'string', description: '文件路径' },
                    edits: {
                        type: 'array',
                        description: '修改列表',
                        items: {
                            type: 'object',
                            description: '修改项',
                            properties: {
                                search: { type: 'string', description: '要替换的代码' },
                                replace: { type: 'string', description: '新代码' },
                                description: { type: 'string', description: '修改说明' },
                            },
                        },
                    },
                },
            },
        },
        atomic: {
            type: 'boolean',
            description: '是否原子操作（任一失败则全部回滚）',
            default: false,
        },
    },
    requiredParams: ['files'],
    requiredPermissions: [types_1.Permission.FILE_WRITE],
    riskLevel: 'high',
    idempotent: false,
    timeout: 30000,
    requiresConfirmation: true,
};
/** 创建 multi_file_edit 执行器 */
function createMultiFileEditExecutor(deps) {
    return async (params, context) => {
        const files = params.files || [];
        const atomic = Boolean(params.atomic);
        const traceId = context?.traceId || '';
        if (files.length === 0) {
            return {
                success: false,
                output: null,
                error: '请提供至少一个文件修改项',
                duration: 0,
                validated: false,
            };
        }
        if (files.length > 50) {
            return {
                success: false,
                output: null,
                error: '单次最多修改50个文件，请分批操作',
                duration: 0,
                validated: false,
            };
        }
        const results = [];
        const rollbackStack = [];
        for (const file of files) {
            const filePath = file.path;
            const edits = file.edits || [];
            if (!filePath || typeof filePath !== 'string') {
                results.push({
                    path: filePath || '未知路径',
                    success: false,
                    appliedCount: 0,
                    error: '无效的文件路径',
                });
                continue;
            }
            try {
                const fileExists = fs.existsSync(filePath);
                let content = fileExists ? fs.readFileSync(filePath, 'utf-8') : '';
                const originalContent = content;
                let appliedCount = 0;
                for (const edit of edits) {
                    if (edit.search &&
                        typeof edit.search === 'string' &&
                        content.includes(edit.search)) {
                        content = content.replaceAll(edit.search, edit.replace || '');
                        appliedCount++;
                    }
                }
                if (appliedCount > 0) {
                    rollbackStack.push({ path: filePath, originalContent });
                    const dir = path_1.default.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(filePath, content, 'utf-8');
                    await deps.addToHistory(filePath, {
                        content: originalContent,
                        timestamp: Date.now(),
                        description: `多文件修改: ${appliedCount}处`,
                    });
                    results.push({ path: filePath, success: true, appliedCount });
                }
                else {
                    results.push({
                        path: filePath,
                        success: false,
                        appliedCount: 0,
                        error: '未找到任何匹配的代码片段',
                    });
                }
            }
            catch (err) {
                results.push({
                    path: filePath,
                    success: false,
                    appliedCount: 0,
                    error: err.message,
                });
            }
        }
        const failures = results.filter((r) => !r.success);
        if (atomic && failures.length > 0 && rollbackStack.length > 0) {
            Logger_1.Logger.info(`↩️ 原子模式：回滚 ${rollbackStack.length} 个文件`, 'MultiFileEdit');
            for (const item of rollbackStack) {
                try {
                    fs.writeFileSync(item.path, item.originalContent, 'utf-8');
                    await deps.removeHistory(item.path, 1);
                }
                catch {
                    // 忽略回滚错误
                }
            }
            return {
                success: false,
                output: null,
                error: `原子模式：部分修改失败，已回滚所有修改\n失败: ${failures.map((f) => `${f.path}: ${f.error}`).join('\n')}`,
                duration: 0,
                validated: false,
            };
        }
        void EventBus_1.EventBus.emit('multi_file_modified', {
            traceId,
            files: results.map((r) => ({
                path: r.path,
                changeType: 'modified',
            })),
            timestamp: new Date().toISOString(),
        });
        const successCount = results.filter((r) => r.success).length;
        Logger_1.Logger.info(`📝 多文件修改: ${successCount}/${files.length} 个文件成功`, 'MultiFileEdit');
        return {
            success: failures.length === 0,
            output: `修改完成: ${successCount}/${files.length} 个文件\n${results.map((r) => `- ${r.path}: ${r.success ? `✓ ${r.appliedCount}处修改` : `✗ ${r.error}`}`).join('\n')}`,
            duration: 0,
            validated: false,
            metadata: { results },
        };
    };
}
