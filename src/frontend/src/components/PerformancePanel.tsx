import React, { useCallback, useEffect, useState } from 'react';
import './PerformancePanel.css';
import { apiService } from '../api/apiService';

interface PerformanceData {
  memory?: { heapUsed: number; heapTotal: number; rss: number };
  cpu?: { loadAvg: [number, number, number]; cpuCount: number };
  system?: { uptime: number; platform: string; nodeVersion: string };
}

const DEFAULT_DATA: PerformanceData = {
  memory: { heapUsed: 0, heapTotal: 0, rss: 0 },
  cpu: { loadAvg: [0, 0, 0], cpuCount: 1 },
  system: { uptime: 0, platform: 'unknown', nodeVersion: 'unknown' },
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
};

const PerformancePanel: React.FC = () => {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [refreshRate, setRefreshRate] = useState<number>(5000);
  const [isAutoRefresh, setIsAutoRefresh] = useState<boolean>(true);

  const fetchData = useCallback(async () => {
    try {
      const result = await apiService.getPerformanceSnapshot();
      if (result.success && result.data) {
        const d = result.data as unknown as Record<string, unknown>;
        setData({
          memory: (d.memory as PerformanceData['memory']) || DEFAULT_DATA.memory,
          cpu: (d.cpu as PerformanceData['cpu']) || DEFAULT_DATA.cpu,
          system: (d.system as PerformanceData['system']) || DEFAULT_DATA.system,
        });
      } else {
        setData(DEFAULT_DATA);
      }
    } catch {
      setData(DEFAULT_DATA);
    }
  }, []);

  useEffect(() => {
    if (isAutoRefresh) {
      fetchData();
      const interval = setInterval(fetchData, refreshRate);
      return () => clearInterval(interval);
    }
  }, [fetchData, isAutoRefresh, refreshRate]);

  if (!data || !data.memory || !data.cpu || !data.system) {
    return <div className="performance-loading">加载中...</div>;
  }

  const memoryUsagePercent =
    data.memory.heapTotal > 0 ? Math.round((data.memory.heapUsed / data.memory.heapTotal) * 100) : 0;

  const memoryTrend: 'up' | 'down' | 'stable' =
    memoryUsagePercent > 80 ? 'up' : memoryUsagePercent < 50 ? 'down' : 'stable';

  const cpuTrend: 'up' | 'stable' = data.cpu.loadAvg[0] > data.cpu.cpuCount ? 'up' : 'stable';

  return (
    <div className="performance-panel">
      <div className="performance-header">
        <h2 className="performance-title">性能监控</h2>
        <div className="performance-controls">
          <button className="performance-refresh-btn" onClick={fetchData}>
            刷新
          </button>
          <div className="performance-toggle">
            <span className="performance-toggle-label">自动刷新</span>
            <input
              type="checkbox"
              className="performance-toggle-input"
              checked={isAutoRefresh}
              onChange={(e) => setIsAutoRefresh(e.target.checked)}
            />
          </div>
          <select
            className="performance-rate-select"
            value={refreshRate}
            onChange={(e) => setRefreshRate(Number(e.target.value))}
          >
            <option value={2000}>2秒</option>
            <option value={5000}>5秒</option>
            <option value={10000}>10秒</option>
            <option value={30000}>30秒</option>
          </select>
        </div>
      </div>

      <div className="performance-metrics-grid">
        <div className={`performance-metric-card ${memoryUsagePercent > 80 ? 'warn' : ''}`}>
          <div className="performance-metric-title">内存使用</div>
          <div className="performance-metric-value">
            {formatBytes(data.memory.heapUsed)}
            <span className="performance-metric-unit">of {formatBytes(data.memory.heapTotal)}</span>
          </div>
          <span className={`performance-metric-trend ${memoryTrend}`}>
            {memoryTrend === 'up' ? '↑' : memoryTrend === 'down' ? '↓' : '→'}
          </span>
        </div>

        <div
          className={`performance-metric-card ${
            memoryUsagePercent > 80 ? 'warn' : memoryUsagePercent > 60 ? '' : 'good'
          }`}
        >
          <div className="performance-metric-title">内存占用率</div>
          <div className="performance-metric-value">{memoryUsagePercent}%</div>
          <span className={`performance-metric-trend ${memoryTrend}`}>
            {memoryTrend === 'up' ? '↑' : memoryTrend === 'down' ? '↓' : '→'}
          </span>
        </div>

        <div className="performance-metric-card purple">
          <div className="performance-metric-title">RSS 内存</div>
          <div className="performance-metric-value">{formatBytes(data.memory.rss)}</div>
        </div>

        <div className={`performance-metric-card ${cpuTrend === 'up' ? 'warn' : 'good'}`}>
          <div className="performance-metric-title">CPU 负载 (1分钟)</div>
          <div className="performance-metric-value">{data.cpu.loadAvg[0].toFixed(2)}</div>
          <span className={`performance-metric-trend ${cpuTrend}`}>{cpuTrend === 'up' ? '↑' : '→'}</span>
        </div>

        <div className="performance-metric-card cyan">
          <div className="performance-metric-title">CPU 核心数</div>
          <div className="performance-metric-value">{data.cpu.cpuCount}</div>
        </div>

        <div className="performance-metric-card slate">
          <div className="performance-metric-title">系统运行时间</div>
          <div className="performance-metric-value">{formatUptime(data.system.uptime)}</div>
        </div>
      </div>

      <div className="performance-system-info">
        <h3 className="performance-info-title">系统信息</h3>
        <div className="performance-info-grid">
          <div className="performance-info-item">
            <span className="performance-info-label">平台</span>
            <span className="performance-info-value">{data.system.platform}</span>
          </div>
          <div className="performance-info-item">
            <span className="performance-info-label">Node.js 版本</span>
            <span className="performance-info-value">{data.system.nodeVersion}</span>
          </div>
          <div className="performance-info-item">
            <span className="performance-info-label">最后更新</span>
            <span className="performance-info-value">{new Date().toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PerformancePanel;
