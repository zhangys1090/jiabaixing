"use strict";
/**
 * Harness Tool: write_approval - 文件写入审批
 *
 * 在执行高风险文件写入操作前，向用户请求审批。
 * 与 ApprovalManager 集成，支持预览变更、审批/拒绝流程。
 * 确保用户对关键文件修改有完全控制权。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WRITE_APPROVAL_DEF = void 0;
exports.createWriteApprovalExecutor = createWriteApprovalExecutor;
const Logger_1 = require("../../../utils/Logger");
const EventBus_1 = require("../../../shared/EventBus");
const types_1 = require("../../types");
exports.WRITE_APPROVAL_DEF = {
    name: 'write_approval',
    description: '文件写入审批工具。在执行高风险写入操作（如修改配置文件、删除文件、批量编辑）前，向用户展示变更预览并请求审批。适用场景：修改关键配置、批量文件操作、不可逆的写入操作。不适用：低风险的新建文件、临时文件操作。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        operation: {
            type: 'string',
            description: '请求审批的操作类型：file_write|file_delete|batch_edit|config_change',
            enum: ['file_write', 'file_delete', 'batch_edit', 'config_change'],
        },
        target: {
            type: 'string',
            description: '操作目标（文件路径或描述）',
        },
        changes: {
            type: 'string',
            description: '变更内容描述或 diff 预览',
        },
        risk_reason: {
            type: 'string',
            description: '为什么需要审批的原因说明',
        },
        auto_approve: {
            type: 'boolean',
            description: '是否自动批准（仅用于低风险场景的快速通道）',
            default: false,
        },
    },
    requiredParams: ['operation', 'target', 'changes'],
    requiredPermissions: [types_1.Permission.FILE_WRITE],
    riskLevel: 'medium',
    idempotent: false,
    timeout: 120000,
    requiresConfirmation: true,
};
const OPERATION_ICON = {
    file_write: '📝',
    file_delete: '🗑️',
    batch_edit: '📋',
    config_change: '⚙️',
};
const OPERATION_LABEL = {
    file_write: '文件写入',
    file_delete: '文件删除',
    batch_edit: '批量编辑',
    config_change: '配置变更',
};
function buildApprovalMessage(operation, target, changes, riskReason) {
    const icon = OPERATION_ICON[operation] || '⚠️';
    const label = OPERATION_LABEL[operation] || operation;
    const lines = [
        `${icon} 写入审批请求`,
        '',
        `操作类型: ${label}`,
        `目标: ${target}`,
        '',
        '变更内容:',
        changes.length > 500
            ? `${changes.substring(0, 500)}...（已截断）`
            : changes,
    ];
    if (riskReason) {
        lines.push('', `⚠️ 风险说明: ${riskReason}`);
    }
    return lines.join('\n');
}
function createWriteApprovalExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const operation = String(params.operation || '');
        const target = String(params.target || '');
        const changes = String(params.changes || '');
        const riskReason = params.risk_reason
            ? String(params.risk_reason)
            : undefined;
        const autoApprove = Boolean(params.auto_approve);
        if (!operation || !target || !changes) {
            return {
                success: false,
                output: '',
                error: '缺少必要参数: operation, target, changes',
                duration: Date.now() - startTime,
                validated: false,
            };
        }
        if (autoApprove) {
            Logger_1.Logger.info(`🔓 write_approval 自动批准: ${operation} → ${target}`, 'WriteApproval');
            return {
                success: true,
                output: `✅ 已自动批准: ${OPERATION_LABEL[operation] || operation} → ${target}`,
                duration: Date.now() - startTime,
                validated: true,
                metadata: { autoApproved: true, operation, target },
            };
        }
        const approvalMessage = buildApprovalMessage(operation, target, changes, riskReason);
        void EventBus_1.EventBus.emit('write_approval_request', {
            operation,
            target,
            changes: changes.substring(0, 1000),
            riskReason,
            timestamp: new Date().toISOString(),
        });
        if (deps.approvalManager) {
            try {
                const result = await deps.approvalManager.requestApproval('write_approval', { operation, target, changes: changes.substring(0, 500) }, 'medium');
                if (result.approved) {
                    Logger_1.Logger.info(`✅ write_approval 审批通过: ${operation} → ${target}`, 'WriteApproval');
                    return {
                        success: true,
                        output: `✅ 审批通过: ${OPERATION_LABEL[operation] || operation} → ${target}`,
                        duration: Date.now() - startTime,
                        validated: true,
                        metadata: { approved: true, operation, target },
                    };
                }
                Logger_1.Logger.info(`❌ write_approval 审批拒绝: ${operation} → ${target} (${result.reason || '用户拒绝'})`, 'WriteApproval');
                return {
                    success: false,
                    output: `❌ 审批拒绝: ${OPERATION_LABEL[operation] || operation} → ${target}`,
                    error: result.reason || '用户拒绝审批',
                    duration: Date.now() - startTime,
                    validated: false,
                    metadata: {
                        approved: false,
                        operation,
                        target,
                        reason: result.reason,
                    },
                };
            }
            catch (err) {
                Logger_1.Logger.error(`❌ write_approval 审批流程异常: ${err.message}`, err, 'WriteApproval');
                return {
                    success: false,
                    output: '',
                    error: `审批流程异常: ${err.message}`,
                    duration: Date.now() - startTime,
                    validated: false,
                };
            }
        }
        Logger_1.Logger.info(`⏳ write_approval 等待审批: ${operation} → ${target}`, 'WriteApproval');
        return {
            success: true,
            output: approvalMessage,
            duration: Date.now() - startTime,
            validated: false,
            needsConfirmation: true,
            metadata: {
                operation,
                target,
                pendingApproval: true,
            },
        };
    };
}
