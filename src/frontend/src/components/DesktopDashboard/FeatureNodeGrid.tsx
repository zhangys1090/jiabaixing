import React from 'react';

export interface FeatureNode {
  id: string;
  icon: string;
  label: string;
  description: string;
  color: string;
}

export interface FeatureNodeGridProps {
  onNodeClick: (node: FeatureNode) => void;
}

export const FEATURE_NODES: FeatureNode[] = [
  {
    id: 'clarify',
    icon: '🔍',
    label: '澄清工具',
    description: '需求澄清与边界确认',
    color: '#6366f1',
  },
  {
    id: 'todo',
    icon: '📝',
    label: 'TODO规划',
    description: '自动拆解任务清单',
    color: '#22c55e',
  },
  {
    id: 'sandbox',
    icon: '🧪',
    label: '代码沙箱',
    description: '安全执行代码片段',
    color: '#f59e0b',
  },
  {
    id: 'subagent',
    icon: '🤖',
    label: '子Agent委托',
    description: '分配子任务给专用Agent',
    color: '#8b5cf6',
  },
  {
    id: 'approval',
    icon: '✅',
    label: '写入审批',
    description: '文件变更需审批',
    color: '#10b981',
  },
  {
    id: 'budget',
    icon: '💰',
    label: '预算守卫',
    description: 'Token与成本监控',
    color: '#ef4444',
  },
  {
    id: 'osv',
    icon: '🛡️',
    label: '漏洞检查',
    description: '依赖漏洞扫描',
    color: '#f97316',
  },
  {
    id: 'cleanup',
    icon: '🧹',
    label: '磁盘清理',
    description: '预览并清理临时文件',
    color: '#06b6d4',
  },
  {
    id: 'voice',
    icon: '🎙️',
    label: '语音对话',
    description: '语音输入与播报',
    color: '#ec4899',
  },
  {
    id: 'workspace',
    icon: '🏢',
    label: '多项目工作区',
    description: '切换项目上下文',
    color: '#3b82f6',
  },
  {
    id: 'i18n',
    icon: '🌐',
    label: '国际化',
    description: '多语言界面支持',
    color: '#14b8a6',
  },
  {
    id: 'plugin',
    icon: '🔌',
    label: '插件系统',
    description: '扩展Agent能力',
    color: '#a855f7',
  },
];

/**
 * 家百星执行Agent特色功能节点网格
 * 展示T0-T4批次沉淀的核心能力入口
 */
const FeatureNodeGrid: React.FC<FeatureNodeGridProps> = ({ onNodeClick }) => {
  return (
    <div className="feature-node-section">
      <div className="feature-node-header">
        <span className="feature-node-title">⚡ 执行Agent特色能力</span>
        <span className="feature-node-subtitle">点击卡片快速体验</span>
      </div>
      <ul className="feature-node-grid" aria-label="执行Agent特色能力">
        {FEATURE_NODES.map((node) => (
          <li key={node.id}>
            <button
              className="feature-node-card"
              onClick={() => onNodeClick(node)}
              title={node.description}
              aria-label={`${node.label}: ${node.description}`}
              style={{ '--node-accent': node.color } as React.CSSProperties}
            >
              <span className="feature-node-icon" aria-hidden="true">
                {node.icon}
              </span>
              <span className="feature-node-label">{node.label}</span>
              <span className="feature-node-desc">{node.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default FeatureNodeGrid;
