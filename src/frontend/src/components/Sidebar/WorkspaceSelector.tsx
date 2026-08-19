import React from 'react';

export interface Workspace {
  id: string;
  name: string;
  icon?: string;
}

interface WorkspaceSelectorProps {
  workspaces?: Workspace[];
  currentWorkspaceId?: string;
  onSelect?: (workspaceId: string) => void;
  collapsed?: boolean;
}

export const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({
  workspaces = [],
  currentWorkspaceId,
  onSelect,
  collapsed = false,
}) => {
  const current = workspaces.find((w) => w.id === currentWorkspaceId) || workspaces[0];

  return (
    <div className="workspace-selector">
      <button
        className="workspace-selector-trigger"
        onClick={() => current && onSelect?.(current.id)}
        title={current?.name || '选择工作区'}
      >
        <span className="workspace-icon">{current?.icon || '💼'}</span>
        {!collapsed && (
          <>
            <span className="workspace-name">{current?.name || '未命名工作区'}</span>
            <span className="workspace-chevron">▾</span>
          </>
        )}
      </button>
    </div>
  );
};

export default WorkspaceSelector;
