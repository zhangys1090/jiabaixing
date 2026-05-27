import React, { useState } from 'react';
import './ToolResultCard.css';

interface ToolResultCardProps {
  toolName: string;
  status: 'success' | 'error' | 'running';
  duration?: number;
  result?: string;
  error?: string;
  filePath?: string;
}

export const ToolResultCard: React.FC<ToolResultCardProps> = ({
  toolName,
  status,
  duration,
  result,
  error,
  filePath,
}) => {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = status === 'success' ? '✓' : status === 'error' ? '✗' : '◉';

  return (
    <div className="tool-result-card">
      <div
        className={`tool-result-card__header tool-result-card__header--${status}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-result-card__tool-icon">🔧</span>
        <span className="tool-result-card__tool-name">{toolName}</span>
        {filePath && <span className="tool-result-card__file-path">{filePath}</span>}
        {duration !== undefined && <span className="tool-result-card__meta-info">{duration}ms</span>}
        <span className={`tool-result-card__status-badge tool-result-card__status-badge--${status}`}>
          {statusIcon} {status === 'success' ? '成功' : status === 'error' ? '失败' : '运行中'}
        </span>
      </div>

      {expanded && error && <div className="tool-result-card__error-content">{error}</div>}
      {expanded && result && <div className="tool-result-card__result-content">{result}</div>}
    </div>
  );
};
