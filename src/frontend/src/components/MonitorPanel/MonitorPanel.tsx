import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../api/apiService';
import type { SystemResourcesResponse } from '@shared/contracts';
import { useMonitorStore } from '../../stores/useMonitorStore';
import './MonitorPanel.css';

type MonitorTab = 'resources' | 'llm' | 'integrity' | 'logs';

interface LlmPerf {
  calls: number;
  successRate: number;
  avgLatency: number;
  tokens: string;
}

interface IntegrityItem {
  name: string;
  status: 'pass' | 'fail' | 'warn';
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatUptime = (seconds: number): string => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const MonitorPanel: React.FC = () => {
  const { logs, clearLogs, setSystemResources, setLlmPerformance, setIntegrityChecks } = useMonitorStore();

  const [activeTab, setActiveTab] = useState<MonitorTab>('resources');
  const [logFilter, setLogFilter] = useState<string>('all');
  const [_loading, setLoading] = useState(false);
  const [resources, setResources] = useState<SystemResourcesResponse | null>(null);
  const [llmPerf, setLlmPerf] = useState<LlmPerf>({
    calls: 0,
    successRate: 0,
    avgLatency: 0,
    tokens: '0',
  });
  const [integrity, setIntegrity] = useState<IntegrityItem[]>([]);

  const loadSystemResources = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiService.getSystemResources();
      if (result.success && result.data) {
        setResources(result.data);
        setSystemResources(result.data as unknown as Record<string, unknown>);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [setSystemResources]);

  const loadLlmPerformance = useCallback(async () => {
    try {
      const result = await apiService.getPerformanceSnapshot();
      if (result.success && result.data) {
        const data = result.data as Record<string, unknown>;
        const memPct = data.memory
          ? Math.round(
              ((data.memory as Record<string, number>).heapUsed / (data.memory as Record<string, number>).heapTotal) *
                100
            )
          : 0;
        const perf: LlmPerf = {
          calls: ((data as Record<string, unknown>).callCount as number) || 0,
          successRate: 100 - memPct,
          avgLatency: ((data as Record<string, unknown>).avgLatency as number) || 0,
          tokens: String((data as Record<string, unknown>).totalTokens || '0'),
        };
        setLlmPerf(perf);
        setLlmPerformance(data);
      }
    } catch {
      /* ignore */
    }
  }, [setLlmPerformance]);

  const loadIntegrity = useCallback(async () => {
    try {
      const result = await apiService.getSystemIntegrity();
      if (result.success && result.data) {
        const checks = result.data.checks.map((c) => ({
          name: c.name,
          status: c.status as IntegrityItem['status'],
        }));
        setIntegrity(checks);
        setIntegrityChecks(result.data.checks);
      }
    } catch {
      /* ignore */
    }
  }, [setIntegrityChecks]);

  useEffect(() => {
    if (activeTab === 'resources') loadSystemResources();
    else if (activeTab === 'llm') loadLlmPerformance();
    else if (activeTab === 'integrity') loadIntegrity();
  }, [activeTab, loadSystemResources, loadLlmPerformance, loadIntegrity]);

  const memoryPct = resources?.memory?.usagePercent ?? 0;
  const cpuPct = resources?.cpu?.loadAverage?.[0]
    ? Math.min(100, Math.round((resources.cpu.loadAverage[0] / (resources.cpu.count || 1)) * 100))
    : 0;

  const getColorClass = (pct: number): string => {
    if (pct > 80) return 'red';
    if (pct > 60) return 'orange';
    return 'green';
  };

  const filteredLogs = logFilter === 'all' ? logs : logs.filter((l) => l.level === logFilter);

  return (
    <div className="monitor-panel">
      <div className="monitor-panel__tab-bar">
        {(['resources', 'llm', 'integrity', 'logs'] as MonitorTab[]).map((tab) => (
          <button
            key={tab}
            className={`monitor-panel__tab ${activeTab === tab ? 'monitor-panel__tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {
              {
                resources: '资源',
                llm: 'LLM',
                integrity: '完整性',
                logs: '日志',
              }[tab]
            }
          </button>
        ))}
      </div>

      <div className="monitor-panel__scrollable">
        {activeTab === 'resources' && (
          <div className="monitor-panel__section">
            <div className="monitor-panel__section-title">系统资源</div>

            <div className="monitor-panel__resource-row">
              <span className="monitor-panel__resource-label">CPU</span>
              <span className="monitor-panel__resource-value">{cpuPct}%</span>
            </div>
            <div className="monitor-panel__resource-bar">
              <div
                className={`monitor-panel__resource-fill monitor-panel__resource-fill--${getColorClass(cpuPct)}`}
                style={{ width: `${cpuPct}%` }}
              />
            </div>

            <div className="monitor-panel__resource-row">
              <span className="monitor-panel__resource-label">内存</span>
              <span className="monitor-panel__resource-value">{memoryPct}%</span>
            </div>
            <div className="monitor-panel__resource-bar">
              <div
                className={`monitor-panel__resource-fill monitor-panel__resource-fill--${getColorClass(memoryPct)}`}
                style={{ width: `${memoryPct}%` }}
              />
            </div>

            <div className="monitor-panel__resource-row">
              <span className="monitor-panel__resource-label">RSS</span>
              <span className="monitor-panel__resource-value">{formatBytes(resources?.memory?.rss ?? 0)}</span>
            </div>

            <div className="monitor-panel__resource-row">
              <span className="monitor-panel__resource-label">运行时间</span>
              <span className="monitor-panel__resource-value">{formatUptime(resources?.process?.uptime ?? 0)}</span>
            </div>
          </div>
        )}

        {activeTab === 'llm' && (
          <div className="monitor-panel__section">
            <div className="monitor-panel__section-title">LLM 性能</div>
            <div className="monitor-panel__llm-stats">
              <div className="monitor-panel__stat-card">
                <div className="monitor-panel__stat-value">{llmPerf.calls}</div>
                <div className="monitor-panel__stat-label">调用次数</div>
              </div>
              <div className="monitor-panel__stat-card">
                <div className="monitor-panel__stat-value">
                  {llmPerf.successRate}
                  <span className="monitor-panel__stat-unit">%</span>
                </div>
                <div className="monitor-panel__stat-label">成功率</div>
              </div>
              <div className="monitor-panel__stat-card">
                <div className="monitor-panel__stat-value">
                  {llmPerf.avgLatency}
                  <span className="monitor-panel__stat-unit">s</span>
                </div>
                <div className="monitor-panel__stat-label">平均延迟</div>
              </div>
              <div className="monitor-panel__stat-card">
                <div className="monitor-panel__stat-value">{llmPerf.tokens}</div>
                <div className="monitor-panel__stat-label">Token 使用</div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'integrity' && (
          <div className="monitor-panel__section">
            <div className="monitor-panel__section-title">完整性检查</div>
            {integrity.length === 0 ? (
              <div className="monitor-panel__log-empty">点击刷新加载完整性数据</div>
            ) : (
              <div className="monitor-panel__integrity-grid">
                {integrity.map((item, i) => (
                  <div
                    key={i}
                    className={`monitor-panel__integrity-item monitor-panel__integrity-item--${item.status}`}
                  >
                    <div className="monitor-panel__integrity-icon">
                      {item.status === 'pass' ? '✓' : item.status === 'fail' ? '✗' : '⚠'}
                    </div>
                    <div>{item.name}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="monitor-panel__section">
            <div className="monitor-panel__section-title">实时日志</div>
            <div className="monitor-panel__log-filter">
              {['all', 'error', 'warn', 'info'].map((level) => (
                <button
                  key={level}
                  className={`monitor-panel__filter-btn ${logFilter === level ? 'monitor-panel__filter-btn--active' : ''}`}
                  onClick={() => setLogFilter(level)}
                >
                  {{ all: '全部', error: '错误', warn: '警告', info: '信息' }[level]}
                </button>
              ))}
            </div>
            <div className="monitor-panel__log-list">
              {filteredLogs.length === 0 ? (
                <div className="monitor-panel__log-empty">暂无日志</div>
              ) : (
                filteredLogs
                  .slice(-50)
                  .reverse()
                  .map((log, i) => (
                    <div
                      key={i}
                      className={`monitor-panel__log-entry monitor-panel__log-entry--${log.level || 'info'}`}
                    >
                      <span className="monitor-panel__log-time">{String(log.timestamp || '').slice(-8, -3)}</span>
                      <span className="monitor-panel__log-message">{log.message}</span>
                    </div>
                  ))
              )}
            </div>
            <div className="monitor-panel__action-row">
              <button className="monitor-panel__action-btn" onClick={loadSystemResources}>
                刷新
              </button>
              <button className="monitor-panel__action-btn" onClick={clearLogs}>
                清空
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
