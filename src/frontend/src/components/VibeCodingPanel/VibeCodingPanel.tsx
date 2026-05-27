import React from 'react';
import './VibeCodingPanel.css';
import { WsClarificationRequestData, WsExecutionPreviewData, WsToolTraceData } from '@shared/contracts';

export type ClarificationRequest = WsClarificationRequestData;

export type ExecutionPreview = WsExecutionPreviewData;

export type ToolTraceEvent = WsToolTraceData;

interface VibeCodingPanelProps {
  clarificationRequest: ClarificationRequest | null;
  executionPreview: ExecutionPreview | null;
  toolTraces: ToolTraceEvent[];
  onClarificationResponse: (response: string) => void;
  onExecutionConfirm: (confirmed: boolean) => void;
}

export const VibeCodingPanel: React.FC<VibeCodingPanelProps> = ({
  clarificationRequest,
  executionPreview,
  toolTraces,
  onClarificationResponse,
  onExecutionConfirm,
}) => {
  return (
    <div className="vibe-coding-panel">
      {/* 澄清提问弹窗 */}
      {clarificationRequest && (
        <div className="clarification-modal">
          <div className="clarification-content">
            <h3>🤔 需要澄清</h3>
            <p className="clarification-question">{clarificationRequest.question}</p>
            {clarificationRequest.context && <p className="clarification-context">{clarificationRequest.context}</p>}
            {clarificationRequest.options.length > 0 ? (
              <div className="clarification-options">
                {clarificationRequest.options.map((option, index) => (
                  <button
                    key={index}
                    className="clarification-option-btn"
                    onClick={() => onClarificationResponse(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="text"
                className="clarification-input"
                placeholder="请输入您的回答..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onClarificationResponse((e.target as HTMLInputElement).value);
                  }
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* 执行预览面板 */}
      {executionPreview && (
        <div className={`execution-preview risk-${executionPreview.changes?.[0]?.risk || 'low'}`}>
          <div className="preview-header">
            <h4>📋 执行预览</h4>
            <span className={`risk-badge ${executionPreview.changes?.[0]?.risk || 'low'}`}>
              {(executionPreview.changes?.[0]?.risk || 'low') === 'high'
                ? '⚠️ 高风险'
                : (executionPreview.changes?.[0]?.risk || 'low') === 'medium'
                  ? '⚡ 中风险'
                  : '✅ 低风险'}
            </span>
          </div>
          <p className="preview-summary">{executionPreview.summary}</p>
          <div className="preview-actions">
            {(executionPreview.changes || []).map((change, index) => (
              <div key={index} className="preview-action-item">
                <span className="action-file">{change.target || '未知目标'}</span>
                <span className="action-desc">{change.action}</span>
              </div>
            ))}
          </div>
          <div className="preview-buttons">
            <button className="confirm-btn" onClick={() => onExecutionConfirm(true)}>
              ✓ 确认执行
            </button>
            <button className="cancel-btn" onClick={() => onExecutionConfirm(false)}>
              ✗ 取消
            </button>
          </div>
        </div>
      )}

      {/* 工具追踪面板 */}
      {toolTraces.length > 0 && (
        <div className="tool-trace-panel">
          <h4>🔧 工具执行追踪</h4>
          <div className="trace-list">
            {toolTraces.slice(-5).map((trace, index) => (
              <div key={index} className={`trace-item status-${trace.status}`}>
                <span className="trace-tool">{trace.toolName}</span>
                <span className="trace-status">
                  {trace.status === 'completed' ? '✓' : trace.status === 'failed' ? '✗' : '⏳'}
                </span>
                <span className="trace-duration">{trace.duration}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default VibeCodingPanel;
