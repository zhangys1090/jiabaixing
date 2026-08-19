"use strict";
/**
 * Harness Tool: preview_execution - 高风险操作预览确认
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREVIEW_EXECUTION_DEF = void 0;
exports.createPreviewExecutionExecutor = createPreviewExecutionExecutor;
const EventBus_1 = require("../../../shared/EventBus");
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.PREVIEW_EXECUTION_DEF = {
    name: 'preview_execution',
    description: '在执行高风险操作前，展示将要执行的操作预览，等待用户确认。适用场景：批量修改文件、删除操作、重构代码、执行系统命令。不适用：读取文件、查询信息等安全操作。',
    category: types_1.ToolCategory.SYSTEM,
    parameters: {
        actions: {
            type: 'array',
            description: '将要执行的操作列表，每项包含 {file, action, description}',
            items: {
                type: 'object',
                description: '操作项',
                properties: {
                    file: { type: 'string', description: '目标文件路径' },
                    action: { type: 'string', description: '操作类型' },
                    description: { type: 'string', description: '操作描述' },
                },
            },
        },
        risk_level: {
            type: 'string',
            description: '风险等级: low=低风险(可自动执行), medium=中风险(建议确认), high=高风险(必须确认)',
            enum: ['low', 'medium', 'high'],
        },
        summary: {
            type: 'string',
            description: '操作摘要说明',
        },
    },
    requiredParams: ['actions', 'risk_level'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
/** 创建 preview_execution 执行器 */
function createPreviewExecutionExecutor() {
    return async (params, context) => {
        const actions = params.actions || [];
        const riskLevel = String(params.risk_level || 'medium');
        const summary = String(params.summary || '');
        const traceId = context?.traceId || '';
        if (actions.length === 0) {
            return {
                success: false,
                output: null,
                error: '请提供至少一个操作项',
                duration: 0,
                validated: false,
            };
        }
        const validRiskLevels = ['low', 'medium', 'high'];
        if (!validRiskLevels.includes(riskLevel)) {
            return {
                success: false,
                output: null,
                error: `无效的风险等级: ${riskLevel}，必须是 low/medium/high`,
                duration: 0,
                validated: false,
            };
        }
        void EventBus_1.EventBus.emit('execution_preview', {
            traceId,
            summary,
            changes: actions.map((a) => ({
                type: 'file',
                target: a.file || '',
                action: a.action || '',
                risk: riskLevel,
            })),
            timestamp: new Date().toISOString(),
        });
        Logger_1.Logger.info(`📋 执行预览: ${actions.length}个操作, 风险=${riskLevel}`, 'PreviewExecution');
        const needsConfirmation = riskLevel === 'high' || riskLevel === 'medium';
        return {
            success: true,
            output: needsConfirmation
                ? `已展示操作预览(${actions.length}个操作, 风险=${riskLevel})，等待用户确认后执行。`
                : `已记录操作计划(${actions.length}个操作)，可直接执行。`,
            duration: 0,
            validated: false,
            metadata: { needsConfirmation, previewId: traceId },
        };
    };
}
