import React from 'react';
import './LeftRail.css';

export type ModuleId =
  | 'chat'
  | 'memory'
  | 'agent'
  | 'evolution'
  | 'skills'
  | 'desktop'
  | 'automation'
  | 'security'
  | 'monitor';

interface NavItem {
  id: ModuleId;
  icon: string;
  label: string;
  shortcut: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat', icon: '💬', label: '对话', shortcut: 'Ctrl+1' },
  { id: 'memory', icon: '🧠', label: '记忆', shortcut: 'Ctrl+2' },
  { id: 'agent', icon: '🤖', label: 'Agent', shortcut: 'Ctrl+3' },
  { id: 'evolution', icon: '🧬', label: '进化', shortcut: 'Ctrl+4' },
  { id: 'skills', icon: '🔧', label: '技能', shortcut: 'Ctrl+5' },
  { id: 'desktop', icon: '🖥', label: '桌面', shortcut: 'Ctrl+6' },
  { id: 'automation', icon: '⚡', label: '自动化', shortcut: 'Ctrl+7' },
  { id: 'security', icon: '🛡', label: '安全', shortcut: 'Ctrl+8' },
  { id: 'monitor', icon: '📊', label: '监控', shortcut: 'Ctrl+9' },
];

interface LeftRailProps {
  activeModule: ModuleId;
  onModuleChange: (moduleId: ModuleId) => void;
}

export const LeftRail: React.FC<LeftRailProps> = ({ activeModule, onModuleChange }) => {
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const index = parseInt(e.key, 10);
        if (index >= 1 && index <= NAV_ITEMS.length) {
          e.preventDefault();
          onModuleChange(NAV_ITEMS[index - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onModuleChange]);

  return (
    <div className="layout-left-rail">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`layout-left-rail__nav-btn${activeModule === item.id ? ' layout-left-rail__nav-btn--active' : ''}`}
          data-label={`${item.label} (${item.shortcut})`}
          onClick={() => onModuleChange(item.id)}
        >
          {activeModule === item.id && <span className="layout-left-rail__active-indicator" />}
          {item.icon}
        </button>
      ))}
    </div>
  );
};
