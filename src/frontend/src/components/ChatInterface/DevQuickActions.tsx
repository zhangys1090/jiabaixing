import React, { useState } from 'react';
import './DevQuickActions.css';

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;
  category: 'analyze' | 'generate' | 'optimize' | 'test';
}

interface DevQuickActionsProps {
  onAction: (action: QuickAction) => void;
  disabled?: boolean;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  {
    id: 'analyze-project',
    label: '分析项目',
    icon: '🔍',
    prompt: '分析当前项目结构和代码质量，给出优化建议',
    category: 'analyze',
  },
  {
    id: 'analyze-performance',
    label: '分析性能',
    icon: '⚡',
    prompt: '分析当前选中代码的性能问题，给出优化建议',
    category: 'analyze',
  },
  {
    id: 'generate-tests',
    label: '生成单元测试',
    icon: '🧪',
    prompt: '为当前选中代码生成完整的单元测试',
    category: 'test',
  },
  {
    id: 'optimize-code',
    label: '优化代码',
    icon: '✨',
    prompt: '优化当前选中代码的可读性和性能',
    category: 'optimize',
  },
  {
    id: 'code-review',
    label: '代码审查',
    icon: '👀',
    prompt: '审查当前选中代码，找出潜在问题和改进点',
    category: 'analyze',
  },
  {
    id: 'generate-docs',
    label: '生成文档',
    icon: '📝',
    prompt: '为当前选中代码生成清晰的文档注释',
    category: 'generate',
  },
];

const DevQuickActions: React.FC<DevQuickActionsProps> = ({ onAction, disabled = false }) => {
  const [sentActionId, setSentActionId] = useState<string | null>(null);

  const handleActionClick = (action: QuickAction) => {
    if (disabled) return;

    setSentActionId(action.id);
    onAction(action);

    setTimeout(() => {
      setSentActionId(null);
    }, 1500);
  };

  return (
    <div className="dev-quick-actions">
      <div className="dev-actions-label">🛠️ 开发快捷指令</div>
      <div className="dev-actions-grid">
        {DEFAULT_ACTIONS.map((action) => {
          const isSent = sentActionId === action.id;
          const isDisabled = disabled && !isSent;

          return (
            <button
              key={action.id}
              className={`dev-action-btn dev-action-${action.category} ${isSent ? 'action-sent' : ''}`}
              onClick={() => handleActionClick(action)}
              disabled={isDisabled}
              title={action.prompt}
            >
              <span className="action-icon">{action.icon}</span>
              <span className="action-label">{isSent ? '已发送 ✓' : action.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export { DEFAULT_ACTIONS };
export default DevQuickActions;
