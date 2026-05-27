import React, { useState, useEffect } from 'react';
import './AutomationPanel.css';

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  schedule: string;
  priority: number;
  enabled: boolean;
  executionCount: number;
  successCount: number;
  averageExecutionTime: number;
  lastRun?: string;
  nextRun?: string;
}

export interface ProactiveTrigger {
  type: string;
  reason: string;
  priority: number;
  suggestedAction?: string;
  context?: Record<string, unknown>;
  timestamp: number;
}

export interface UserBehaviorPattern {
  activeHours: number[];
  frequentTopics: string[];
  taskCompletionRate: number;
  lastActiveTime: number;
  averageSessionDuration: number;
  preferredCommunicationStyle: string;
}

interface AutomationPanelProps {
  tasks?: ScheduledTask[];
  proactiveTriggers?: ProactiveTrigger[];
  behaviorPatterns?: UserBehaviorPattern;
  onTaskToggle?: (taskId: string, enabled: boolean) => void;
  onTaskCreate?: (task: Partial<ScheduledTask>) => void;
  onTriggerExecute?: (trigger: ProactiveTrigger) => void;
}

const AutomationPanel: React.FC<AutomationPanelProps> = ({
  tasks: externalTasks,
  proactiveTriggers: externalTriggers,
  behaviorPatterns: externalPatterns,
  onTaskToggle,
  onTaskCreate,
  onTriggerExecute,
}) => {
  const [activeTab, setActiveTab] = useState<'tasks' | 'triggers' | 'patterns'>('tasks');
  const [tasks, setTasks] = useState<ScheduledTask[]>(externalTasks || []);
  const [triggers, setTriggers] = useState<ProactiveTrigger[]>(externalTriggers || []);
  const [patterns, setPatterns] = useState<UserBehaviorPattern | null>(externalPatterns || null);

  useEffect(() => {
    if (externalTasks) setTasks(externalTasks);
  }, [externalTasks]);

  useEffect(() => {
    if (externalTriggers) setTriggers(externalTriggers);
  }, [externalTriggers]);

  useEffect(() => {
    if (externalPatterns) setPatterns(externalPatterns);
  }, [externalPatterns]);

  const getTriggerIcon = (type: ProactiveTrigger['type']) => {
    const icons: Record<string, string> = {
      schedule: '⏰',
      emotion: '😊',
      behavior: '📊',
      pattern: '🔄',
      time: '🕐',
      memory: '🧠',
    };
    return icons[type] || '🎯';
  };

  const getPriorityColor = (priority: number) => {
    if (priority >= 9) return 'high';
    if (priority >= 7) return 'medium';
    return 'low';
  };

  const getPriorityLabel = (priority: number) => {
    if (priority >= 9) return '🔴 高优先级';
    if (priority >= 7) return '🟡 中优先级';
    return '🟢 低优先级';
  };

  return (
    <div className="automation-panel">
      <div className="panel-header">
        <h2>⚡ 智能自动化</h2>
        <p className="panel-subtitle">LLM主导的智能自动化系统</p>
        <div className="tab-nav">
          <button className={`tab-btn ${activeTab === 'tasks' ? 'active' : ''}`} onClick={() => setActiveTab('tasks')}>
            📋 任务列表
          </button>
          <button
            className={`tab-btn ${activeTab === 'triggers' ? 'active' : ''}`}
            onClick={() => setActiveTab('triggers')}
          >
            🎯 主动触发
          </button>
          <button
            className={`tab-btn ${activeTab === 'patterns' ? 'active' : ''}`}
            onClick={() => setActiveTab('patterns')}
          >
            📊 行为模式
          </button>
        </div>
      </div>

      <div className="panel-content">
        {activeTab === 'tasks' && (
          <div className="task-list-panel">
            <div className="task-actions">
              <button
                className="btn-primary"
                onClick={() => {
                  const taskName = prompt('请输入任务名称：');
                  if (taskName && onTaskCreate) {
                    onTaskCreate({
                      name: taskName,
                      description: '用户创建的任务',
                      schedule: '0 9 * * *',
                      priority: 5,
                    });
                  }
                }}
              >
                ➕ 新建任务
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  if (onTaskCreate) {
                    onTaskCreate({
                      name: '__refresh__',
                      description: '',
                      schedule: '',
                      priority: 0,
                    });
                  }
                }}
              >
                🔄 刷新
              </button>
            </div>

            <div className="task-list">
              {tasks.length === 0 ? (
                <div className="empty-state">
                  <p>暂无自动化任务</p>
                  <p className="hint">点击"新建任务"创建您的第一个自动化任务</p>
                </div>
              ) : (
                tasks.map((task) => (
                  <div key={task.id} className={`task-item ${task.enabled ? 'enabled' : 'disabled'}`}>
                    <div className="task-header">
                      <h3>{task.name}</h3>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={task.enabled}
                          onChange={(e) => {
                            if (onTaskToggle) {
                              onTaskToggle(task.id, e.target.checked);
                            }
                            setTasks((prev) =>
                              prev.map((t) => (t.id === task.id ? { ...t, enabled: e.target.checked } : t))
                            );
                          }}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                    <p className="task-description">{task.description}</p>
                    <div className="task-meta">
                      <span className="task-schedule">⏰ {task.schedule}</span>
                      <span className="task-priority">{getPriorityLabel(task.priority)}</span>
                      <span className="task-stats">
                        执行: {task.executionCount}次 | 成功: {task.successCount}次
                      </span>
                    </div>
                    {task.lastRun && (
                      <div className="task-last-run">上次执行: {new Date(task.lastRun).toLocaleString()}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'triggers' && (
          <div className="proactive-trigger-panel">
            <div className="trigger-header">
              <h3>主动触发队列</h3>
              <span className="trigger-count">{triggers.length} 个待执行</span>
            </div>

            <div className="trigger-list">
              {triggers.length === 0 ? (
                <div className="empty-state">
                  <p>暂无主动触发</p>
                  <p className="hint">系统会根据用户行为、情绪、日程自动触发</p>
                </div>
              ) : (
                triggers.map((trigger, index) => (
                  <div key={index} className={`trigger-item priority-${getPriorityColor(trigger.priority)}`}>
                    <div className="trigger-icon">{getTriggerIcon(trigger.type)}</div>
                    <div className="trigger-content">
                      <div className="trigger-reason">{trigger.reason}</div>
                      {trigger.suggestedAction && <div className="trigger-action">建议: {trigger.suggestedAction}</div>}
                      {trigger.context && (
                        <div className="trigger-context">
                          <pre>{JSON.stringify(trigger.context, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                    <div className="trigger-actions">
                      <button
                        className="btn-execute"
                        onClick={() => {
                          if (onTriggerExecute) {
                            onTriggerExecute(trigger);
                          }
                          setTriggers((prev) => prev.filter((_, i) => i !== index));
                        }}
                      >
                        ▶️ 执行
                      </button>
                      <button
                        className="btn-dismiss"
                        onClick={() => {
                          setTriggers((prev) => prev.filter((_, i) => i !== index));
                        }}
                      >
                        ✖️ 忽略
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'patterns' && (
          <div className="behavior-pattern-panel">
            <div className="pattern-header">
              <h3>用户行为模式</h3>
              <span className="pattern-status">{patterns ? '已学习' : '学习中...'}</span>
            </div>

            {patterns ? (
              <div className="pattern-content">
                <div className="pattern-section">
                  <h4>📅 活跃时间</h4>
                  <div className="active-hours">
                    {patterns.activeHours.map((hour, index) => (
                      <span key={index} className={`hour-badge ${hour >= 9 && hour <= 18 ? 'work-hours' : ''}`}>
                        {hour}:00
                      </span>
                    ))}
                  </div>
                </div>

                <div className="pattern-section">
                  <h4>💬 常用话题</h4>
                  <div className="frequent-topics">
                    {patterns.frequentTopics.map((topic, index) => (
                      <span key={index} className="topic-tag">
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="pattern-section">
                  <h4>📊 任务完成率</h4>
                  <div className="completion-rate">
                    <div className="rate-bar">
                      <div
                        className="rate-fill"
                        style={{
                          width: `${patterns.taskCompletionRate * 100}%`,
                        }}
                      ></div>
                    </div>
                    <span className="rate-text">{(patterns.taskCompletionRate * 100).toFixed(1)}%</span>
                  </div>
                </div>

                <div className="pattern-section">
                  <h4>⏱️ 平均会话时长</h4>
                  <p className="session-duration">{Math.floor(patterns.averageSessionDuration / 60)} 分钟</p>
                </div>

                <div className="pattern-section">
                  <h4>🗣️ 沟通风格偏好</h4>
                  <p className="communication-style">{patterns.preferredCommunicationStyle}</p>
                </div>

                <div className="pattern-section">
                  <h4>🕐 最后活跃时间</h4>
                  <p className="last-active">{new Date(patterns.lastActiveTime).toLocaleString()}</p>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>正在学习您的行为模式...</p>
                <p className="hint">继续使用系统，我们会更好地理解您的习惯</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AutomationPanel;
