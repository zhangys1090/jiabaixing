import React, { useEffect, useRef } from 'react';
import './QuickToolPalette.css';

export interface ToolItem {
  id: string;
  name: string;
  icon: string;
  category: string;
}

export interface QuickToolPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTool: (toolId: string) => void;
}

const TOOL_CATEGORIES: { id: string; label: string; tools: ToolItem[] }[] = [
  {
    id: 'file',
    label: '文件',
    tools: [
      { id: 'file.read', name: '读取文件', icon: '📄', category: 'file' },
      { id: 'file.write', name: '写入文件', icon: '✏️', category: 'file' },
      { id: 'file.search', name: '文件搜索', icon: '🔍', category: 'file' },
    ],
  },
  {
    id: 'code',
    label: '代码',
    tools: [
      { id: 'code.analysis', name: '代码分析', icon: '🔬', category: 'code' },
      { id: 'code.refactor', name: '重构建议', icon: '🧹', category: 'code' },
      { id: 'code.generate', name: '生成代码', icon: '⚡', category: 'code' },
    ],
  },
  {
    id: 'search',
    label: '搜索',
    tools: [
      { id: 'search.web', name: '联网搜索', icon: '🌐', category: 'search' },
      { id: 'search.local', name: '本地搜索', icon: '🗂️', category: 'search' },
      { id: 'search.memory', name: '记忆搜索', icon: '🧠', category: 'search' },
    ],
  },
  {
    id: 'plan',
    label: '规划',
    tools: [
      { id: 'plan.task', name: '任务规划', icon: '📋', category: 'plan' },
      { id: 'plan.breakdown', name: '拆解目标', icon: '🎯', category: 'plan' },
      { id: 'plan.schedule', name: '定时执行', icon: '⏰', category: 'plan' },
    ],
  },
  {
    id: 'approval',
    label: '审批',
    tools: [
      { id: 'approval.request', name: '请求审批', icon: '✋', category: 'approval' },
      { id: 'approval.history', name: '审批记录', icon: '📜', category: 'approval' },
      { id: 'approval.policy', name: '策略配置', icon: '⚖️', category: 'approval' },
    ],
  },
  {
    id: 'security',
    label: '安全',
    tools: [
      { id: 'security.scan', name: '安全扫描', icon: '🛡️', category: 'security' },
      { id: 'security.audit', name: '审计日志', icon: '🔒', category: 'security' },
      { id: 'secret.mask', name: '密钥脱敏', icon: '🔑', category: 'security' },
    ],
  },
];

/**
 * 快捷工具面板
 * 聊天输入框左侧 "+" 按钮触发的工具选择弹窗
 */
export const QuickToolPalette: React.FC<QuickToolPaletteProps> = ({ isOpen, onClose, onSelectTool }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleSelect = (toolId: string) => {
    onSelectTool(toolId);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="quick-tool-palette-overlay">
      <div className="quick-tool-palette" ref={panelRef} role="dialog" aria-modal="true">
        <div className="quick-tool-palette-header">
          <span className="quick-tool-palette-title">快捷工具</span>
          <button className="quick-tool-palette-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="quick-tool-palette-grid">
          {TOOL_CATEGORIES.map((category) => (
            <div key={category.id} className="quick-tool-category">
              <div className="quick-tool-category-label">{category.label}</div>
              <div className="quick-tool-category-items">
                {category.tools.map((tool) => (
                  <button
                    key={tool.id}
                    className="quick-tool-item"
                    onClick={() => handleSelect(tool.id)}
                    title={tool.name}
                  >
                    <span className="quick-tool-item-icon">{tool.icon}</span>
                    <span className="quick-tool-item-name">{tool.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default QuickToolPalette;
