"use strict";
/**
 * ApprovalEngine — 统一审批引擎
 *
 * 为执行 Agent 提供安全审批流：
 *   1. 文件写入审批（file_edit/file_write/code_generate 在写入前确认）
 *   2. 危险命令审批（shell_exec 中的 rm/format/del 等高危命令）
 *   3. Skill 执行确认（执行来源不明的 skill 前确认）
 *   4. 网络请求审批（web_fetch 访问未知域名前确认）
 *
 * 审批方式：
 *   - auto: 自动批准（默认，低风险操作）
 *   - inline: 在当前会话中弹出确认（CLI/Web/ACP 不同实现）
 *   - batch: 批量批准同类操作（10分钟内不再询问）
 *   - deny: 拒绝执行
 *
 * 设计参考 Hermes Agent 的 approval.py / write_approval.py
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalEngine = void 0;
exports.getApprovalEngine = getApprovalEngine;
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
/** 默认审批策略 */
const DEFAULT_POLICY = {
    mode: 'smart',
    autoApproveLow: true,
    autoApproveMedium: true,
    requireHumanForHigh: true,
    requireHumanForCritical: true,
    batchWindowMs: 10 * 60 * 1000, // 10 分钟
    timeoutMs: 60 * 1000, // 60 秒
    dangerousCommands: [
        'rm -rf',
        'rmdir /s',
        'del /f',
        'format',
        'fdisk',
        'mkfs',
        'dd if=',
        'shutdown',
        'reboot',
        'halt',
        'kill -9',
        'taskkill /f',
        'chmod 777',
        'chown',
        'sudo',
        'su root',
        'git push --force',
        'git reset --hard',
        'npm publish',
        'docker rm',
        'docker rmi',
        'kubectl delete',
    ],
    safePaths: ['/tmp/', 'data/', 'snapshots/', 'logs/'],
    protectedPaths: [
        '.env',
        'config/providers.json',
        'package.json',
        'tsconfig.json',
        'src/main.ts',
    ],
};
class ApprovalEngine {
    static DECISION_LOG_MAX = 2000;
    static DECISION_LOG_TRIM_TO = 1500;
    policy;
    pending = new Map();
    batchApprovals = [];
    decisionLog = [];
    constructor(policy) {
        this.policy = { ...DEFAULT_POLICY, ...policy };
        Logger_1.Logger.info('ApprovalEngine 已初始化', 'ApprovalEngine');
    }
    getPolicy() {
        return this.policy;
    }
    /**
     * 更新审批策略
     */
    updatePolicy(updates) {
        this.policy = { ...this.policy, ...updates };
        Logger_1.Logger.info('审批策略已更新', 'ApprovalEngine', { mode: this.policy.mode });
    }
    /**
     * 请求审批
     * 这是核心入口，所有需要审批的操作都通过此方法
     */
    async requestApproval(request) {
        const fullRequest = {
            ...request,
            id: `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
        };
        // 1. 检查是否有批量批准
        const batchMatch = this.checkBatchApproval(fullRequest);
        if (batchMatch) {
            const decision = {
                approved: true,
                method: 'batch',
                batchId: batchMatch.batchId,
                reason: '批量批准窗口内',
                timestamp: Date.now(),
            };
            this.logDecision(fullRequest, decision);
            return decision;
        }
        // 2. 根据策略决定
        if (this.policy.mode === 'auto') {
            return this.autoApprove(fullRequest);
        }
        if (this.policy.mode === 'inline') {
            return this.requestInlineApproval(fullRequest);
        }
        // smart 模式：按风险等级决定
        const risk = this.assessRisk(fullRequest);
        if (risk === 'low' && this.policy.autoApproveLow) {
            return this.autoApprove(fullRequest);
        }
        if (risk === 'medium' && this.policy.autoApproveMedium) {
            return this.autoApprove(fullRequest);
        }
        if (risk === 'high' && !this.policy.requireHumanForHigh) {
            return this.autoApprove(fullRequest);
        }
        if (risk === 'critical' && !this.policy.requireHumanForCritical) {
            return this.autoApprove(fullRequest);
        }
        // 需要人工确认
        return this.requestInlineApproval(fullRequest);
    }
    /**
     * 评估操作的风险等级
     */
    assessRisk(request) {
        // 危险命令检查
        if (request.type === 'shell_exec' || request.type === 'shell_dangerous') {
            const cmd = request.target.toLowerCase();
            for (const dangerous of this.policy.dangerousCommands) {
                if (cmd.includes(dangerous.toLowerCase())) {
                    return 'critical';
                }
            }
            // 写入系统目录
            if (cmd.includes('/etc/') ||
                cmd.includes('c:\\windows\\') ||
                cmd.includes('c:\\system32\\')) {
                return 'critical';
            }
            return 'medium';
        }
        // 文件写入检查
        if (request.type === 'file_write' || request.type === 'file_delete') {
            const filePath = request.target.toLowerCase();
            // 检查受保护路径
            for (const protected_ of this.policy.protectedPaths) {
                if (filePath.includes(protected_.toLowerCase())) {
                    return 'critical';
                }
            }
            // 检查安全路径
            for (const safe of this.policy.safePaths) {
                if (filePath.includes(safe.toLowerCase())) {
                    return 'low';
                }
            }
            // 文件删除始终是高风险
            if (request.type === 'file_delete') {
                return 'high';
            }
            return 'medium';
        }
        // 多文件修改
        if (request.type === 'multi_file_edit') {
            return 'high';
        }
        // Skill 执行
        if (request.type === 'skill_execute') {
            return 'low';
        }
        if (request.type === 'skill_unknown_source') {
            return 'high';
        }
        // 网络请求
        if (request.type === 'network_request') {
            return 'low';
        }
        if (request.type === 'network_unknown_domain') {
            return 'medium';
        }
        // 代码生成
        if (request.type === 'code_generation') {
            return 'medium';
        }
        return 'medium';
    }
    /**
     * 自动批准
     */
    autoApprove(request) {
        const decision = {
            approved: true,
            method: 'auto',
            reason: '自动批准（策略允许）',
            timestamp: Date.now(),
        };
        this.logDecision(request, decision);
        return decision;
    }
    /**
     * 请求人工审批（通过 EventBus 发出审批请求）
     * CLI/Web/ACP 不同入口监听此事件并展示确认 UI
     */
    requestInlineApproval(request) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                // 超时视为拒绝
                const decision = {
                    approved: false,
                    method: 'timeout',
                    reason: `审批超时（${this.policy.timeoutMs / 1000}秒）`,
                    timestamp: Date.now(),
                };
                this.pending.delete(request.id);
                this.logDecision(request, decision);
                resolve(decision);
            }, this.policy.timeoutMs);
            this.pending.set(request.id, { request, resolve, timer });
            // 通过 EventBus 发出审批请求，等待 UI 层响应
            EventBus_1.EventBus.emit('approval_request', request);
            Logger_1.Logger.info(`📤 审批请求已发出: ${request.type} - ${request.target} (风险: ${this.assessRisk(request)})`, 'ApprovalEngine');
        });
    }
    /**
     * 响应审批请求（由 UI 层调用）
     * CLI 的 readline / Web 的对话框 / ACP 的 JSON-RPC 都调用此方法
     */
    respondToApproval(requestId, approved, batchApprove) {
        const pending_ = this.pending.get(requestId);
        if (!pending_) {
            Logger_1.Logger.warn(`审批请求不存在或已过期: ${requestId}`, 'ApprovalEngine');
            return false;
        }
        if (pending_.timer) {
            clearTimeout(pending_.timer);
        }
        const decision = {
            approved,
            method: batchApprove ? 'batch' : 'inline',
            batchId: batchApprove ? `batch_${Date.now().toString(36)}` : undefined,
            reason: approved ? '用户批准' : '用户拒绝',
            timestamp: Date.now(),
        };
        // 如果批量批准，记录到 batchApprovals
        if (approved && batchApprove) {
            this.batchApprovals.push({
                batchId: decision.batchId,
                type: pending_.request.type,
                target: pending_.request.target,
                expiresAt: Date.now() + this.policy.batchWindowMs,
            });
        }
        this.pending.delete(requestId);
        this.logDecision(pending_.request, decision);
        pending_.resolve(decision);
        Logger_1.Logger.info(`📥 审批响应: ${approved ? '✅ 批准' : '❌ 拒绝'} - ${pending_.request.type} ${pending_.request.target}`, 'ApprovalEngine');
        return true;
    }
    /**
     * 检查是否有匹配的批量批准
     * 支持精确匹配(type+target)和类型匹配(仅type)
     */
    checkBatchApproval(request) {
        const now = Date.now();
        this.batchApprovals = this.batchApprovals.filter((b) => b.expiresAt > now);
        const exactMatch = this.batchApprovals.find((b) => b.type === request.type && b.target === request.target);
        if (exactMatch)
            return exactMatch;
        const typeMatch = this.batchApprovals.find((b) => b.type === request.type);
        if (typeMatch && request.risk !== 'critical' && request.risk !== 'high') {
            return typeMatch;
        }
        return null;
    }
    /**
     * 记录审批决策（用于审计）
     */
    logDecision(request, decision) {
        this.decisionLog.push({ request, decision });
        if (this.decisionLog.length > ApprovalEngine.DECISION_LOG_MAX) {
            this.decisionLog = this.decisionLog.slice(-ApprovalEngine.DECISION_LOG_TRIM_TO);
        }
        EventBus_1.EventBus.emit('approval_request', {
            id: request.id,
            type: request.type,
            description: request.description,
            target: request.target,
            risk: request.risk,
            approved: decision.approved,
            method: decision.method,
        });
    }
    /**
     * 获取待审批请求列表
     */
    getPendingApprovals() {
        return Array.from(this.pending.values()).map((p) => p.request);
    }
    /**
     * 获取审批历史
     */
    getDecisionLog(limit) {
        return limit ? this.decisionLog.slice(-limit) : [...this.decisionLog];
    }
    /**
     * 获取审批统计
     */
    getStats() {
        const stats = {
            total: this.decisionLog.length,
            approved: 0,
            denied: 0,
            timedOut: 0,
            pending: this.pending.size,
            byType: {},
        };
        for (const { decision, request } of this.decisionLog) {
            if (decision.approved)
                stats.approved++;
            else if (decision.method === 'timeout')
                stats.timedOut++;
            else
                stats.denied++;
            stats.byType[request.type] = (stats.byType[request.type] || 0) + 1;
        }
        return stats;
    }
}
exports.ApprovalEngine = ApprovalEngine;
/** 全局单例 */
let approvalEngine = null;
function getApprovalEngine() {
    if (!approvalEngine) {
        approvalEngine = new ApprovalEngine();
    }
    return approvalEngine;
}
