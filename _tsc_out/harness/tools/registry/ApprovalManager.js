"use strict";
/**
 * Human-in-the-Loop 审批管理器
 *
 * 当工具 requiresConfirmation=true 时，通过 EventBus 发出审批请求，
 * 等待用户通过 API 或 WebSocket 确认/拒绝后继续执行。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalManager = void 0;
const events_1 = require("events");
const Logger_1 = require("../../../utils/Logger");
class ApprovalManager extends events_1.EventEmitter {
    pendingRequests = new Map();
    autoApproveLowRisk;
    REQUEST_TIMEOUT_MS = 120000; // 2分钟超时
    constructor(options) {
        super();
        this.autoApproveLowRisk = options?.autoApproveLowRisk ?? false;
    }
    /**
     * 请求用户审批
     * @param toolName - 工具名称
     * @param params - 工具参数
     * @param riskLevel - 风险等级
     * @returns 审批结果
     */
    async requestApproval(toolName, params, riskLevel) {
        // 低风险且配置了自动批准
        if (this.autoApproveLowRisk && riskLevel === 'low') {
            Logger_1.Logger.info(`🔓 自动批准低风险工具: ${toolName}`, 'ApprovalManager');
            return { approved: true };
        }
        const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const request = {
            id,
            toolName,
            params,
            riskLevel,
            timestamp: Date.now(),
            status: 'pending',
        };
        return new Promise((resolve) => {
            this.pendingRequests.set(id, { resolve, request });
            this.emit('approvalRequested', request);
            Logger_1.Logger.info(`⏳ 等待用户审批: ${toolName} (风险=${riskLevel}, id=${id})`, 'ApprovalManager');
            // 超时自动拒绝
            setTimeout(() => {
                const entry = this.pendingRequests.get(id);
                if (entry && entry.request.status === 'pending') {
                    entry.request.status = 'rejected';
                    entry.request.reason = '审批超时';
                    entry.resolve({ approved: false, reason: '审批超时，已自动拒绝' });
                    this.pendingRequests.delete(id);
                    Logger_1.Logger.warn(`⏰ 审批超时自动拒绝: ${toolName} (${id})`, 'ApprovalManager');
                }
            }, this.REQUEST_TIMEOUT_MS);
        });
    }
    /**
     * 响应审批请求
     * @param requestId - 审批请求ID
     * @param approved - 是否批准
     * @param reason - 原因（可选）
     * @returns 是否成功响应
     */
    respondApproval(requestId, approved, reason) {
        const entry = this.pendingRequests.get(requestId);
        if (!entry || entry.request.status !== 'pending')
            return false;
        entry.request.status = approved ? 'approved' : 'rejected';
        entry.request.reason = reason;
        entry.resolve({ approved, reason });
        this.pendingRequests.delete(requestId);
        Logger_1.Logger.info(`${approved ? '✅' : '❌'} 审批${approved ? '通过' : '拒绝'}: ${entry.request.toolName} (${requestId})`, 'ApprovalManager');
        return true;
    }
    /**
     * 获取所有待审批请求
     * @returns 待审批请求列表
     */
    getPendingRequests() {
        return Array.from(this.pendingRequests.values())
            .map((e) => e.request)
            .filter((r) => r.status === 'pending');
    }
}
exports.ApprovalManager = ApprovalManager;
