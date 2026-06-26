/**
 * Human-in-the-Loop 审批弹窗组件
 *
 * 当有 pending approval 时弹出，显示工具名、参数、风险等级，
 * 用户可以批准或拒绝。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { getApiBaseUrl } from '../../api/apiService';
import './ApprovalDialog.css';

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

interface ApprovalDialogProps {
  /** 是否显示 */
  visible: boolean;
  /** 待审批请求列表 */
  pendingRequests: ApprovalRequest[];
  /** 关闭回调 */
  onClose?: () => void;
}

const RISK_COLORS: Record<string, string> = {
  low: '#4caf50',
  medium: '#ff9800',
  high: '#f44336',
  critical: '#9c27b0',
};

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '极高风险',
};

const TIMEOUT_MS = 120000;

const ApprovalDialog: React.FC<ApprovalDialogProps> = ({
  visible,
  pendingRequests,
  onClose,
}) => {
  const [rejectReason, setRejectReason] = useState('');
  const [responding, setResponding] = useState<string | null>(null);
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  // 超时倒计时
  useEffect(() => {
    if (!visible || pendingRequests.length === 0) return;

    const interval = setInterval(() => {
      const updated: Record<string, number> = {};
      for (const req of pendingRequests) {
        const elapsed = Date.now() - req.timestamp;
        const remaining = Math.max(0, TIMEOUT_MS - elapsed);
        updated[req.id] = Math.ceil(remaining / 1000);
      }
      setCountdowns(updated);
    }, 1000);

    return () => clearInterval(interval);
  }, [visible, pendingRequests]);

  const handleRespond = useCallback(
    async (requestId: string, approved: boolean) => {
      setResponding(requestId);
      try {
        const baseUrl = getApiBaseUrl();
        const response = await fetch(`${baseUrl}/api/approval/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            approved,
            reason: approved ? undefined : rejectReason || undefined,
          }),
        });
        const data = await response.json();
        if (!data.success) {
          console.error('审批响应失败:', data.error);
        }
      } catch (err) {
        console.error('审批请求失败:', err);
      } finally {
        setResponding(null);
        setRejectReason('');
      }
    },
    [rejectReason]
  );

  if (!visible || pendingRequests.length === 0) return null;

  const currentRequest = pendingRequests[0];
  const riskColor = RISK_COLORS[currentRequest.riskLevel] || '#757575';
  const riskLabel = RISK_LABELS[currentRequest.riskLevel] || currentRequest.riskLevel;
  const countdown = countdowns[currentRequest.id] ?? 120;

  return (
    <div className="approval-overlay" onClick={onClose}>
      <div
        className="approval-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="工具审批确认"
      >
        <div className="approval-header">
          <h2>🔐 工具审批确认</h2>
          <span
            className="approval-risk-badge"
            style={{ backgroundColor: riskColor }}
          >
            {riskLabel}
          </span>
        </div>

        <div className="approval-body">
          <div className="approval-info">
            <div className="approval-field">
              <span className="approval-label">工具名称</span>
              <span className="approval-value approval-tool-name">
                {currentRequest.toolName}
              </span>
            </div>

            <div className="approval-field">
              <span className="approval-label">调用参数</span>
              <pre className="approval-params">
                {JSON.stringify(currentRequest.params, null, 2)}
              </pre>
            </div>

            <div className="approval-field">
              <span className="approval-label">超时倒计时</span>
              <span
                className={`approval-countdown ${countdown < 30 ? 'urgent' : ''}`}
              >
                {countdown}s
              </span>
            </div>
          </div>

          {pendingRequests.length > 1 && (
            <div className="approval-queue">
              队列中还有 {pendingRequests.length - 1} 个待审批请求
            </div>
          )}

          <div className="approval-reason">
            <label className="approval-label" htmlFor="reject-reason">
              拒绝原因（可选）
            </label>
            <input
              id="reject-reason"
              type="text"
              className="approval-reason-input"
              placeholder="输入拒绝原因..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
        </div>

        <div className="approval-actions">
          <button
            className="approval-btn approval-btn-reject"
            onClick={() => handleRespond(currentRequest.id, false)}
            disabled={responding === currentRequest.id}
          >
            {responding === currentRequest.id ? '处理中...' : '❌ 拒绝'}
          </button>
          <button
            className="approval-btn approval-btn-approve"
            onClick={() => handleRespond(currentRequest.id, true)}
            disabled={responding === currentRequest.id}
          >
            {responding === currentRequest.id ? '处理中...' : '✅ 批准'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApprovalDialog;
