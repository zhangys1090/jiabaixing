import React, { useCallback, useRef } from 'react';
import './RightPanel.css';

interface RightPanelProps {
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: React.ReactNode;
  width?: number;
  onWidthChange?: (width: number) => void;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  title,
  collapsed,
  onToggleCollapse,
  children,
  width: controlledWidth = 320,
  onWidthChange,
}) => {
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = controlledWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return;
        const delta = startX.current - moveEvent.clientX;
        const newWidth = Math.max(240, Math.min(600, startWidth.current + delta));
        onWidthChange?.(newWidth);
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [controlledWidth, onWidthChange]
  );

  return (
    <div
      className={`layout-right-panel${collapsed ? ' layout-right-panel--collapsed' : ''}`}
      style={collapsed ? undefined : { width: `${controlledWidth}px`, minWidth: '240px' }}
    >
      {!collapsed && (
        <>
          {onWidthChange && <div className="layout-right-panel__resize-handle" onMouseDown={handleMouseDown} />}
          <button
            className="layout-right-panel__collapse-btn transition-fast hover-scale"
            onClick={onToggleCollapse}
            title="收起面板"
          >
            ▶
          </button>
          <div className="layout-right-panel__content-wrapper">
            <div className="layout-right-panel__header">{title}</div>
            {children}
          </div>
        </>
      )}
    </div>
  );
};
