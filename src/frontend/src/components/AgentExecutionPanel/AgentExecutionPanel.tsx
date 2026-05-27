import React, { useState, useEffect, useCallback } from 'react';
import './AgentExecutionPanel.css';
import { BrainStageUpdate, PerceptionUpdate, SkillExecutionUpdate } from '../../hooks/useWebSocket';
import { apiService } from '../../api/apiService';

export type AgentStepStatus = 'pending' | 'in-progress' | 'completed' | 'failed';

export interface AgentStep {
  name: string;
  label: string;
  status: AgentStepStatus;
  duration?: number;
}

interface EvolutionMetrics {
  totalInteractions: number;
  avgQualityScore: number;
  improvementsApplied: number;
  lastOptimization: string;
  learningRate: number;
}

interface SystemStatus {
  llmAvailable: boolean;
  modelName: string;
  memoryItems: number;
  uptime: number;
  circuitBreakerOpen: boolean;
}

const DEFAULT_STEPS: AgentStep[] = [
  { name: 'perceive', label: '感知', status: 'pending' },
  { name: 'plan', label: '规划', status: 'pending' },
  { name: 'execute', label: '执行', status: 'pending' },
  { name: 'verify', label: '校验', status: 'pending' },
  { name: 'output', label: '输出', status: 'pending' },
  { name: 'learn', label: '学习', status: 'pending' },
];

const STATUS_ICONS: Record<AgentStepStatus, string> = {
  pending: '○',
  'in-progress': '◉',
  completed: '●',
  failed: '✕',
};

const STAGE_TO_STEP: Record<string, string> = {
  intent_recognition: 'perceive',
  scene_recognition: 'perceive',
  task_decomposition: 'plan',
  memory_retrieval: 'perceive',
  llm_generation: 'output',
  persona_adjustment: 'output',
};

interface AgentExecutionPanelProps {
  steps?: AgentStep[];
  isRunning?: boolean;
  onStop?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  brainStageUpdates?: BrainStageUpdate[];
  perceptionUpdates?: PerceptionUpdate[];
  skillExecutionUpdates?: SkillExecutionUpdate[];
}

export const AgentExecutionPanel: React.FC<AgentExecutionPanelProps> = ({
  steps: externalSteps,
  isRunning: externalIsRunning,
  onStop,
  collapsed: externalCollapsed,
  onToggleCollapse,
  brainStageUpdates = [],
  perceptionUpdates = [],
  skillExecutionUpdates = [],
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;

  const [steps, setSteps] = useState<AgentStep[]>(externalSteps || DEFAULT_STEPS);
  const [isRunning, setIsRunning] = useState(externalIsRunning || false);
  const [evolutionMetrics, setEvolutionMetrics] = useState<EvolutionMetrics | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'execution' | 'learning' | 'status'>('execution');

  useEffect(() => {
    if (externalSteps) {
      setSteps(externalSteps);
    }
  }, [externalSteps]);

  useEffect(() => {
    if (externalIsRunning !== undefined) {
      setIsRunning(externalIsRunning);
    }
  }, [externalIsRunning]);

  useEffect(() => {
    if (brainStageUpdates.length === 0) return;
    const latest = brainStageUpdates[brainStageUpdates.length - 1];
    const stepName = STAGE_TO_STEP[latest.stage];
    if (!stepName) return;

    setSteps((prev) =>
      prev.map((step) => {
        if (step.name === stepName) {
          return {
            ...step,
            status:
              latest.status === 'started' ? 'in-progress' : latest.status === 'completed' ? 'completed' : 'failed',
            duration: latest.duration,
          };
        }
        const stepOrder = DEFAULT_STEPS.map((s) => s.name);
        const currentIdx = stepOrder.indexOf(stepName);
        const stepIdx = stepOrder.indexOf(step.name);
        if (stepIdx < currentIdx && step.status === 'pending') {
          return { ...step, status: 'completed' as AgentStepStatus };
        }
        return step;
      })
    );

    if (latest.status === 'started') {
      setIsRunning(true);
    }
    if (latest.stage === 'persona_adjustment' && latest.status === 'completed') {
      setIsRunning(false);
    }
  }, [brainStageUpdates]);

  useEffect(() => {
    if (perceptionUpdates.length === 0) return;
    const latest = perceptionUpdates[perceptionUpdates.length - 1];
    if (latest.modality === 'fusion' || latest.modality === 'image') {
      setSteps((prev) =>
        prev.map((step) =>
          step.name === 'perceive'
            ? {
                ...step,
                status:
                  latest.status === 'started' || latest.status === 'processing'
                    ? 'in-progress'
                    : latest.status === 'completed'
                      ? 'completed'
                      : 'failed',
              }
            : step
        )
      );
      if (latest.status === 'started') setIsRunning(true);
    }
  }, [perceptionUpdates]);

  useEffect(() => {
    if (skillExecutionUpdates.length === 0) return;
    const latest = skillExecutionUpdates[skillExecutionUpdates.length - 1];
    setSteps((prev) =>
      prev.map((step) =>
        step.name === 'execute'
          ? {
              ...step,
              status:
                latest.step === 'started'
                  ? 'in-progress'
                  : latest.step === 'completed'
                    ? 'completed'
                    : latest.step === 'failed'
                      ? 'failed'
                      : 'in-progress',
              duration: latest.duration,
            }
          : step
      )
    );
    if (latest.step === 'started') setIsRunning(true);
  }, [skillExecutionUpdates]);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const [evolutionResult, healthResult] = await Promise.all([
          apiService.getEvolutionMetrics(),
          apiService.getHealth(),
        ]);

        if (evolutionResult.success && evolutionResult.data) {
          const data = evolutionResult.data;
          setEvolutionMetrics({
            totalInteractions: data.totalOptimizations || 0,
            avgQualityScore: data.averageImprovement ? data.averageImprovement / 100 : 0,
            improvementsApplied: data.totalOptimizations || 0,
            lastOptimization: data.lastUpdate || '-',
            learningRate: data.successRate ? data.successRate / 100 : 0,
          });
        }

        if (healthResult.success && healthResult.data) {
          const health = healthResult.data;
          setSystemStatus({
            llmAvailable: health.llm?.available ?? false,
            modelName: health.model || 'unknown',
            memoryItems: 0,
            uptime: health.uptime || 0,
            circuitBreakerOpen: false,
          });
        }
      } catch {
        // silently ignore
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, []);

  const activeStepIndex = steps.findIndex((s) => s.status === 'in-progress');
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const currentStepName = activeStepIndex >= 0 ? steps[activeStepIndex].label : '';

  const handleToggle = useCallback(() => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed((prev) => !prev);
    }
  }, [onToggleCollapse]);

  const handleStop = useCallback(() => {
    if (onStop && isRunning) {
      onStop();
    }
  }, [onStop, isRunning]);

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  return (
    <div className={`agent-execution-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="panel-header" onClick={handleToggle}>
        <div className="header-left">
          <span className="panel-icon">⚡</span>
          <h4>Agent</h4>
          {isRunning && currentStepName && (
            <div className="marquee-container">
              <div className="marquee-content">
                <span className="current-step">{currentStepName}</span>
                <span className="step-separator">·</span>
                <span className="step-progress">
                  {completedCount}/{steps.length}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="header-right">
          {isRunning && onStop && (
            <button
              className="stop-button"
              onClick={(e) => {
                e.stopPropagation();
                handleStop();
              }}
              title="停止执行"
            >
              <span>■</span>
            </button>
          )}
          <span className="expand-toggle">{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>

      {!collapsed && (
        <div className="panel-content">
          <div className="tab-bar">
            <button
              className={`tab-btn ${activeTab === 'execution' ? 'active' : ''}`}
              onClick={() => setActiveTab('execution')}
            >
              执行流程
            </button>
            <button
              className={`tab-btn ${activeTab === 'learning' ? 'active' : ''}`}
              onClick={() => setActiveTab('learning')}
            >
              学习进化
            </button>
            <button
              className={`tab-btn ${activeTab === 'status' ? 'active' : ''}`}
              onClick={() => setActiveTab('status')}
            >
              系统状态
            </button>
          </div>

          {activeTab === 'execution' && (
            <div className="steps-container">
              {steps.map((step) => (
                <div key={step.name} className={`agent-step ${step.status}`}>
                  <span className="step-icon">{STATUS_ICONS[step.status]}</span>
                  <span className="step-name">{step.label}</span>
                  {step.duration !== undefined && step.status === 'completed' && (
                    <span className="step-duration">{step.duration}ms</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'learning' && (
            <div className="learning-container">
              <div className="metric-row">
                <span className="metric-label">总交互次数</span>
                <span className="metric-value">{evolutionMetrics?.totalInteractions || 0}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">平均质量分</span>
                <span className="metric-value">{((evolutionMetrics?.avgQualityScore || 0) * 100).toFixed(0)}%</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">已应用优化</span>
                <span className="metric-value">{evolutionMetrics?.improvementsApplied || 0} 项</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">学习速率</span>
                <span className="metric-value">{((evolutionMetrics?.learningRate || 0) * 100).toFixed(0)}%</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">上次优化</span>
                <span className="metric-value small">{evolutionMetrics?.lastOptimization || '-'}</span>
              </div>
            </div>
          )}

          {activeTab === 'status' && (
            <div className="status-container">
              <div className="metric-row">
                <span className="metric-label">LLM 状态</span>
                <span className={`metric-value ${systemStatus?.llmAvailable ? 'success' : 'error'}`}>
                  {systemStatus?.llmAvailable ? '✓ 可用' : '✕ 不可用'}
                </span>
              </div>
              <div className="metric-row">
                <span className="metric-label">当前模型</span>
                <span className="metric-value small">{systemStatus?.modelName || '-'}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">运行时间</span>
                <span className="metric-value">{formatUptime(systemStatus?.uptime || 0)}</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">熔断器</span>
                <span className={`metric-value ${systemStatus?.circuitBreakerOpen ? 'error' : 'success'}`}>
                  {systemStatus?.circuitBreakerOpen ? '⚠ 开启' : '✓ 关闭'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
