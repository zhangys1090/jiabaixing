import React, { useCallback, useEffect, useState } from 'react';
import './EvolutionPanel.css';
import { apiService } from '../../api/apiService';
import type { WsEvolutionEventData, EvolutionCycleStatus } from '@shared/contracts';

type EvolutionTab = 'loops' | 'events' | 'metrics' | 'subloops';

interface EvolutionPanelProps {
  visible: boolean;
  onClose?: () => void;
  evolutionEvents?: WsEvolutionEventData[];
}

const eventTypeModifier = (type: string): string => {
  const map: Record<string, string> = {
    quality_assessed: 'quality-assessed',
    micro_optimization: 'micro-optimization',
    deep_optimization: 'deep-optimization',
    strategy_updated: 'strategy-updated',
    threshold_adjusted: 'threshold-adjusted',
  };
  return map[type] || '';
};

export const EvolutionPanel: React.FC<EvolutionPanelProps> = ({ visible, evolutionEvents = [] }) => {
  const [activeTab, setActiveTab] = useState<EvolutionTab>('loops');
  const [cycleStatus, setCycleStatus] = useState<EvolutionCycleStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const loadCycleStatus = useCallback(async () => {
    setLoading(true);
    const result = await apiService.getEvolutionStatus();
    if (result.success && result.data) {
      setCycleStatus(result.data);
    }
    setLoading(false);
  }, []);

  const handleTriggerCycle = useCallback(async () => {
    setLoading(true);
    await apiService.triggerEvolutionCycle();
    setTimeout(loadCycleStatus, 1000);
  }, [loadCycleStatus]);

  const handleTriggerHealing = useCallback(async () => {
    setLoading(true);
    await apiService.triggerHealing();
    setTimeout(loadCycleStatus, 1000);
  }, [loadCycleStatus]);

  const handleTriggerRefactor = useCallback(async () => {
    setLoading(true);
    await apiService.triggerRefactor();
    setTimeout(loadCycleStatus, 1000);
  }, [loadCycleStatus]);

  const handleTriggerEnhance = useCallback(async () => {
    setLoading(true);
    await apiService.triggerEnhance();
    setTimeout(loadCycleStatus, 1000);
  }, [loadCycleStatus]);

  useEffect(() => {
    if (visible) {
      loadCycleStatus();
    }
  }, [visible, loadCycleStatus]);

  const mockMetrics = {
    totalOptimizations: 47,
    successRate: 89,
    averageImprovement: 12,
  };

  const _isLoopActive = (_name: string): boolean => true;

  return (
    <div className="evolution-panel">
      <div className="evolution-panel__tab-bar">
        <button className={`evolution-panel__tab${activeTab === 'loops' ? ' evolution-panel__tab--active' : ''}`} onClick={() => setActiveTab('loops')}>四闭环</button>
        <button className={`evolution-panel__tab${activeTab === 'events' ? ' evolution-panel__tab--active' : ''}`} onClick={() => setActiveTab('events')}>事件</button>
        <button className={`evolution-panel__tab${activeTab === 'metrics' ? ' evolution-panel__tab--active' : ''}`} onClick={() => setActiveTab('metrics')}>指标</button>
        <button className={`evolution-panel__tab${activeTab === 'subloops' ? ' evolution-panel__tab--active' : ''}`} onClick={() => setActiveTab('subloops')}>子引擎</button>
      </div>

      <div className="evolution-panel__scrollable-content">
        {activeTab === 'loops' && (
          <>
            <div className="evolution-panel__section">
              <div className="evolution-panel__section-title">四闭环状态</div>
              <div className="evolution-panel__four-loop-diagram">
                {['evolution', 'tool', 'llm', 'persona'].map((key) => (
                  <div key={key} className={`evolution-panel__loop-node${_isLoopActive(key) ? ' evolution-panel__loop-node--active' : ''}`}>
                    <div className="evolution-panel__loop-icon">{{evolution:'🧬',tool:'🔧',llm:'🤖',persona:'👤'}[key]}</div>
                    <div className="evolution-panel__loop-name">{{evolution:'进化引擎',tool:'工具推荐',llm:'LLM提供者',persona:'人设调整'}[key]}</div>
                    <div className={`evolution-panel__loop-status${_isLoopActive(key) ? ' evolution-panel__loop-status--active' : ''}`}>
                      <span className={`evolution-panel__loop-indicator${_isLoopActive(key) ? ' evolution-panel__loop-indicator--active' : ''}`} />
                      {_isLoopActive(key) ? '活跃' : '空闲'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="evolution-panel__section">
              <div className="evolution-panel__section-title">快速操作</div>
              <div className="evolution-panel__action-row">
                <button className="evolution-panel__action-button evolution-panel__action-button--primary" onClick={handleTriggerCycle} disabled={loading}>
                  {loading ? '执行中...' : '触发完整进化'}
                </button>
              </div>
            </div>
          </>
        )}

        {activeTab === 'events' && (
          <div className="evolution-panel__section">
            <div className="evolution-panel__section-title">进化事件流</div>
            {evolutionEvents.length === 0 ? (<div className="evolution-panel__empty-hint">暂无进化事件</div>) : (
              <div className="evolution-panel__event-list">
                {evolutionEvents.slice(-20).reverse().map((event, i) => {
                  const modifier = eventTypeModifier(event.type || 'unknown');
                  return (
                    <div key={i} className={`evolution-panel__event-item${modifier ? ` evolution-panel__event-item--type-${modifier}` : ''}`}>
                      <span className="evolution-panel__event-content">
                        {event.type === 'quality_assessed' && '🟢 质量评估'}
                        {event.type === 'micro_optimization' && '🔵 微优化'}
                        {event.type === 'deep_optimization' && '🟡 深度优化'}
                        {event.type === 'strategy_updated' && '🔷 策略更新'}
                        {event.type === 'threshold_adjusted' && '🟣 阈值调整'}
                        {!['quality_assessed','micro_optimization','deep_optimization','strategy_updated','threshold_adjusted'].includes(event.type || '') && (event.description || event.type)}
                      </span>
                      {event.score !== undefined && (<span className="evolution-panel__event-score">{(event.score * 100).toFixed(0)}%</span>)}
                      <span className="evolution-panel__event-time">{String(event.timestamp || '').slice(-8, -3)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="evolution-panel__section">
            <div className="evolution-panel__section-title">进化指标</div>
            <div className="evolution-panel__metrics-grid">
              <div className="evolution-panel__metric-card"><div className="evolution-panel__metric-value">{mockMetrics.totalOptimizations}</div><div className="evolution-panel__metric-label">优化次数</div></div>
              <div className="evolution-panel__metric-card"><div className="evolution-panel__metric-value">{mockMetrics.successRate}%</div><div className="evolution-panel__metric-label">成功率</div></div>
              <div className="evolution-panel__metric-card"><div className="evolution-panel__metric-value">{mockMetrics.averageImprovement}%</div><div className="evolution-panel__metric-label">平均提升</div></div>
            </div>
            <div className="evolution-panel__spacing">
              <div className="evolution-panel__section-title">历史趋势</div>
              <div className="evolution-panel__empty-hint">图表开发中...</div>
            </div>
          </div>
        )}

        {activeTab === 'subloops' && (
          <>
            <div className="evolution-panel__section">
              <div className="evolution-panel__section-title">自修复/重构/增强</div>
              <div className="evolution-panel__sub-loop-section">
                {([
                  {label:'🔧 自修复', key:'healing' as const, defaultTotal:3},
                  {label:'♻️ 自重构', key:'refactor' as const, defaultTotal:2},
                  {label:'⚡ 自增强', key:'enhancement' as const, defaultTotal:1},
                ] as const).map(({label,key,defaultTotal}) => (
                  <div key={key} className="evolution-panel__sub-loop-row">
                    <span className="evolution-panel__sub-loop-name">{label}</span>
                    <div className="evolution-panel__sub-loop-stats">
                      <span className="evolution-panel__sub-loop-count">{cycleStatus?.[key]?.total || defaultTotal}次</span>
                      <span className="evolution-panel__sub-loop-success evolution-panel__sub-loop-success--success">{cycleStatus?.[key]?.success || defaultTotal}成功 / 0失败</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="evolution-panel__section">
              <div className="evolution-panel__section-title">子引擎操作</div>
              <div className="evolution-panel__action-row">
                <button className="evolution-panel__action-button" onClick={handleTriggerHealing} disabled={loading}>触发修复</button>
                <button className="evolution-panel__action-button" onClick={handleTriggerRefactor} disabled={loading}>触发重构</button>
                <button className="evolution-panel__action-button" onClick={handleTriggerEnhance} disabled={loading}>触发增强</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};