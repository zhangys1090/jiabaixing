/**
 * Human-in-the-Loop 审批管理器
 *
 * 当工具 requiresConfirmation=true 时，通过 EventBus 发出审批请求，
 * 等待用户通过 API 或 WebSocket 确认/拒绝后继续执行。
 */

import { EventEmitter } from 'events';
import { Logger } from '../../../utils/Logger';

/** 审批请求 */
export interface ApprovalRequest {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  riskLevel: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
  reason?: string;
}

/** 审批响应 */
export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
}

export class ApprovalManager extends EventEmitter {
  private pendingRequests: Map<
    string,
    { resolve: (response: ApprovalResponse) => void; request: ApprovalRequest }
  > = new Map();
  private autoApproveLowRisk: boolean;
  private readonly REQUEST_TIMEOUT_MS = 120000; // 2分钟超时

  constructor(options?: { autoApproveLowRisk?: boolean }) {
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
  async requestApproval(
    toolName: string,
    params: Record<string, unknown>,
    riskLevel: string
  ): Promise<ApprovalResponse> {
    // 低风险且配置了自动批准
    if (this.autoApproveLowRisk && riskLevel === 'low') {
      Logger.info(`🔓 自动批准低风险工具: ${toolName}`, 'ApprovalManager');
      return { approved: true };
    }

    const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const request: ApprovalRequest = {
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
      Logger.info(
        `⏳ 等待用户审批: ${toolName} (风险=${riskLevel}, id=${id})`,
        'ApprovalManager'
      );

      // 超时自动拒绝
      setTimeout(() => {
        const entry = this.pendingRequests.get(id);
        if (entry && entry.request.status === 'pending') {
          entry.request.status = 'rejected';
          entry.request.reason = '审批超时';
          entry.resolve({ approved: false, reason: '审批超时，已自动拒绝' });
          this.pendingRequests.delete(id);
          Logger.warn(
            `⏰ 审批超时自动拒绝: ${toolName} (${id})`,
            'ApprovalManager'
          );
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
  respondApproval(
    requestId: string,
    approved: boolean,
    reason?: string
  ): boolean {
    const entry = this.pendingRequests.get(requestId);
    if (!entry || entry.request.status !== 'pending') return false;
    entry.request.status = approved ? 'approved' : 'rejected';
    entry.request.reason = reason;
    entry.resolve({ approved, reason });
    this.pendingRequests.delete(requestId);
    Logger.info(
      `${approved ? '✅' : '❌'} 审批${approved ? '通过' : '拒绝'}: ${entry.request.toolName} (${requestId})`,
      'ApprovalManager'
    );
    return true;
  }

  /**
   * 获取所有待审批请求
   * @returns 待审批请求列表
   */
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values())
      .map((e) => e.request)
      .filter((r) => r.status === 'pending');
  }
}
