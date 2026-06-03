import React, { useEffect, useState } from 'react';

interface ProviderInfo {
  name: string;
  displayName: string;
  model: string;
  healthy?: boolean;
}

interface SystemStatus {
  uptime: number;
  model: string;
  llm: { available: boolean; message: string };
  providers: ProviderInfo[];
}

const API_BASE = `http://${window.location.hostname}:3111`;

const ConsolePanel: React.FC = () => {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 10000);

    // WebSocket 连接获取实时日志
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://${window.location.hostname}:3111`);
      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'server_log' || data.type === 'tool_trace') {
            setLogs(prev => [...prev.slice(-99), `[${new Date().toLocaleTimeString()}] ${data.message || JSON.stringify(data)}`]);
          }
        } catch {
          // raw message
        }
      };
      ws.onclose = () => setWsConnected(false);
    } catch { /* ws not available */ }

    return () => { clearInterval(interval); ws?.close(); };
  }, []);

  async function loadStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      const data = await res.json();
      const providerRes = await fetch(`${API_BASE}/api/models/status`);
      const providerData = await providerRes.json();
      setStatus({
        uptime: data.uptime || 0,
        model: data.model || 'unknown',
        llm: data.llm || { available: false, message: 'unknown' },
        providers: providerData.models || providerData.data || [],
      });
    } catch { /* ignore */ }
  }

  async function switchModel(name: string) {
    try {
      await fetch(`${API_BASE}/api/models/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      loadStatus();
    } catch { /* ignore */ }
  }

  const uptime = status ? Math.floor(status.uptime / 60) + 'm ' + Math.floor(status.uptime % 60) + 's' : '--';

  return (
    <div style={{ padding: '16px', height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 状态卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        <div className="console-card">
          <div className="console-card-label">系统运行</div>
          <div className="console-card-value">{uptime}</div>
        </div>
        <div className="console-card">
          <div className="console-card-label">LLM 模型</div>
          <div className="console-card-value">{status?.llm.available ? '✅' : '❌'} {status?.llm.message || '--'}</div>
        </div>
        <div className="console-card">
          <div className="console-card-label">WebSocket</div>
          <div className="console-card-value">{wsConnected ? '🟢 已连接' : '🔴 未连接'}</div>
        </div>
      </div>

      {/* Provider 列表 */}
      <div className="console-section">
        <div className="console-section-title">🤖 LLM Provider</div>
        {status?.providers && status.providers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {status.providers.map((p) => (
              <div key={p.name} className="console-provider-row" onClick={() => switchModel(p.name)}>
                <span>{p.healthy === undefined ? '⚪' : p.healthy ? '🟢' : '🔴'}</span>
                <span style={{ fontWeight: 600 }}>{p.displayName}</span>
                <span style={{ color: '#8080b0', fontSize: '12px' }}>{p.model}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: '#8080b0', fontSize: '13px' }}>未加载到 Provider 信息</div>
        )}
      </div>

      {/* 实时日志 */}
      <div className="console-section" style={{ flex: 1, minHeight: 0 }}>
        <div className="console-section-title">📋 实时日志</div>
        <div className="console-log-container">
          {logs.length === 0 ? (
            <div style={{ color: '#555', fontSize: '12px', padding: '8px' }}>等待日志...</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="console-log-line">{log}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ConsolePanel;
