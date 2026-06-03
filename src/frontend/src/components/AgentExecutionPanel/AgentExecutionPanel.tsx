import React, { useEffect, useRef } from 'react';
import type {
  WsBrainStageUpdateData,
  WsPerceptionUpdateData,
  WsSkillExecutionUpdateData,
} from '@shared/contracts';

interface AgentStep {
  name: string;
  label: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
}

interface AgentExecutionPanelProps {
  steps: AgentStep[];
  isRunning: boolean;
  onStop: () => void;
  brainStageUpdates: WsBrainStageUpdateData[];
  perceptionUpdates: WsPerceptionUpdateData[];
  skillExecutionUpdates: WsSkillExecutionUpdateData[];
}

/**
 * AgentExecutionPanel - 跑马灯风格执行状态
 */
const AgentExecutionPanel: React.FC<AgentExecutionPanelProps> = ({
  steps,
  isRunning,
  onStop,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到最新步骤
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [steps]);

  if (!isRunning && steps.length === 0) return null;

  return (
    <div style={{
      background: '#1a1a3e',
      border: '1px solid #2a2a5a',
      borderRadius: '8px',
      padding: '6px 10px',
      marginBottom: '8px',
      fontSize: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    }}>
      {/* 状态指示器 */}
      {isRunning ? (
        <span style={{ color: '#fbbf24', fontSize: '14px', flexShrink: 0, animation: 'pulse 1s infinite' }}>⟳</span>
      ) : (
        <span style={{ color: '#4ade80', fontSize: '14px', flexShrink: 0 }}>✓</span>
      )}

      {/* 跑马灯区域 */}
      <div ref={scrollRef} style={{
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'nowrap',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        scrollBehavior: 'smooth',
        msOverflowStyle: 'none',
        scrollbarWidth: 'none',
      }}>
        {steps.map((step, i) => (
          <span key={i} style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '11px',
            background: step.status === 'completed' ? '#0a2a1a' :
                        step.status === 'failed' ? '#2a0a0a' :
                        step.status === 'in-progress' ? '#2a2a0a' : '#1a1a2a',
            color: step.status === 'completed' ? '#4ade80' :
                   step.status === 'failed' ? '#f87171' :
                   step.status === 'in-progress' ? '#fbbf24' : '#8080b0',
            fontWeight: step.status === 'in-progress' ? '600' : '400',
            flexShrink: 0,
          }}>
            {step.status === 'completed' ? '✓' :
             step.status === 'failed' ? '✗' :
             step.status === 'in-progress' ? '⟳' : '○'}
            {step.label}
          </span>
        ))}
        {isRunning && steps.length > 0 && (
          <span style={{ color: '#555', fontSize: '10px', flexShrink: 0 }}>···</span>
        )}
      </div>

      {/* 停止按钮 */}
      {isRunning && (
        <button
          onClick={onStop}
          style={{
            background: 'transparent',
            border: '1px solid #f87171',
            borderRadius: '4px',
            color: '#f87171',
            padding: '1px 6px',
            fontSize: '10px',
            cursor: 'pointer',
            flexShrink: 0,
            lineHeight: '1.4',
          }}
        >
          ⏹
        </button>
      )}
    </div>
  );
};

export { AgentExecutionPanel };
export default AgentExecutionPanel;
