import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../api/apiService';
import { useSecurityStore } from '../../stores/useSecurityStore';
import './SecurityPanel.css';

interface SecurityStatus {
  inputValidation: 'secure' | 'warning' | 'danger';
  networkGuard: 'secure' | 'warning' | 'danger';
  dataSovereignty: 'secure' | 'warning' | 'danger';
  permissionManagement: 'secure' | 'warning' | 'danger';
  overall: 'secure' | 'warning' | 'danger';
}

interface SovereigntyData {
  localDataSize: string;
  encrypted: boolean;
  audited: boolean;
  externalTransfers: number;
  desensitized: boolean;
  compliant: boolean;
}

const DEFAULT_STATUS: SecurityStatus = {
  inputValidation: 'secure',
  networkGuard: 'secure',
  dataSovereignty: 'secure',
  permissionManagement: 'secure',
  overall: 'secure',
};

const DEFAULT_SOVEREIGNTY: SovereigntyData = {
  localDataSize: '0 MB',
  encrypted: true,
  audited: true,
  externalTransfers: 0,
  desensitized: true,
  compliant: true,
};

const STATUS_LABELS: Record<string, string> = {
  secure: '正常',
  warning: '警告',
  danger: '危险',
};

export const SecurityPanel: React.FC = () => {
  const { logs: storeLogs, validationResult, setLogs, setValidationResult, setOverallStatus } = useSecurityStore();

  // 确保logs始终是数组
  const logs = Array.isArray(storeLogs) ? storeLogs : [];

  const [testInput, setTestInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SecurityStatus>(DEFAULT_STATUS);
  const [sovereignty, _setSovereignty] = useState<SovereigntyData>(DEFAULT_SOVEREIGNTY);

  const loadSecurityData = useCallback(async () => {
    setLoading(true);
    try {
      const [logsResult, statusResult] = await Promise.all([
        apiService.getSecurityLogs(50),
        apiService.getSecurityAudit(),
      ]);
      if (logsResult.success && logsResult.data) {
        // 确保设置的是数组
        const logData = Array.isArray(logsResult.data) ? (logsResult.data as Record<string, unknown>[]) : [];
        setLogs(logData);
      } else {
        setLogs([]);
      }
      if (statusResult.success && statusResult.data) {
        const data = statusResult.data as Record<string, unknown>;
        const newStatus: SecurityStatus = {
          inputValidation: (data.inputValidation as SecurityStatus['inputValidation']) || 'secure',
          networkGuard: (data.networkGuard as SecurityStatus['networkGuard']) || 'secure',
          dataSovereignty: (data.dataSovereignty as SecurityStatus['dataSovereignty']) || 'secure',
          permissionManagement: (data.permissionManagement as SecurityStatus['permissionManagement']) || 'secure',
          overall: (data.overall as SecurityStatus['overall']) || 'secure',
        };
        setStatus(newStatus);
        setOverallStatus(newStatus.overall);
      }
    } catch {
      // 出错时设置空数组
      setLogs([]);
    }
    setLoading(false);
  }, [setLogs, setOverallStatus]);

  const handleValidate = useCallback(async () => {
    if (!testInput.trim()) return;
    setLoading(true);
    try {
      const result = await apiService.validateSecurityInput(testInput);
      if (result.success && result.data) {
        setValidationResult(result.data);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [testInput, setValidationResult]);

  useEffect(() => {
    loadSecurityData();
  }, [loadSecurityData]);

  const statusCards = [
    { key: 'inputValidation' as const, icon: '✓', label: '输入验证' },
    { key: 'networkGuard' as const, icon: '🔒', label: '网络守卫' },
    { key: 'dataSovereignty' as const, icon: '💾', label: '数据主权' },
    { key: 'permissionManagement' as const, icon: '👤', label: '权限管理' },
  ];

  const sovereigntyItems = [
    { value: sovereignty.localDataSize, label: '本地数据' },
    { value: sovereignty.encrypted ? '✓' : '✗', label: '加密' },
    { value: sovereignty.audited ? '✓' : '✗', label: '审计' },
    { value: String(sovereignty.externalTransfers), label: '外部传输' },
    { value: sovereignty.desensitized ? '✓' : '✗', label: '脱敏' },
    { value: sovereignty.compliant ? '✓' : '✗', label: '合规' },
  ];

  return (
    <div className="security-panel">
      <div className="security-panel__scrollable">
        <div className="security-panel__section">
          <div className="security-panel__section-title">安全状态</div>
          <div className={`security-panel__overall-status security-panel__overall-status--${status.overall}`}>
            <span className="security-panel__status-icon">🛡</span>
            <div>
              <div className="security-panel__status-label-text">整体安全状态</div>
              <div className={`security-panel__status-value security-panel__status-value--${status.overall}`}>
                {STATUS_LABELS[status.overall]}
              </div>
            </div>
          </div>
          <div className="security-panel__status-grid">
            {statusCards.map((card) => (
              <div
                key={card.key}
                className={`security-panel__status-card security-panel__status-card--${status[card.key]}`}
              >
                <span className="security-panel__status-icon">{card.icon}</span>
                <div className="security-panel__status-info">
                  <div className="security-panel__status-label-text">{card.label}</div>
                  <div className={`security-panel__status-value security-panel__status-value--${status[card.key]}`}>
                    {STATUS_LABELS[status[card.key]]}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="security-panel__section">
          <div className="security-panel__section-title">输入验证测试</div>
          <textarea
            className="security-panel__test-input"
            placeholder="输入要验证的文本..."
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
          />
          <div className="security-panel__row">
            <button className="security-panel__action-btn" onClick={handleValidate} disabled={loading}>
              {loading ? '验证中...' : '验证'}
            </button>
            <button className="security-panel__action-btn" onClick={() => setTestInput('')}>
              清空
            </button>
          </div>
          {validationResult && (
            <div
              className={`security-panel__test-result ${validationResult.valid ? 'security-panel__test-result--valid' : 'security-panel__test-result--invalid'}`}
            >
              <div>结果: {validationResult.valid ? '✓ 有效' : '✗ 无效'}</div>
              <div>风险等级: {validationResult.riskLevel}</div>
              {validationResult.errors.length > 0 && <div>错误: {validationResult.errors.join(', ')}</div>}
              {validationResult.warnings.length > 0 && <div>警告: {validationResult.warnings.join(', ')}</div>}
            </div>
          )}
        </div>

        <div className="security-panel__section">
          <div className="security-panel__section-title">审计日志</div>
          {loading ? (
            <div className="security-panel__hint">加载中...</div>
          ) : logs.length === 0 ? (
            <div className="security-panel__hint">暂无日志</div>
          ) : (
            <div className="security-panel__audit-log">
              {logs
                .slice(-10)
                .reverse()
                .map((log, i) => (
                  <div
                    key={i}
                    className={`security-panel__log-item security-panel__log-item--${(log.level as string) || 'low'}`}
                  >
                    <span className="security-panel__log-content">{log.message as string}</span>
                    <span className="security-panel__log-time">{String(log.timestamp || '').slice(-8, -3)}</span>
                  </div>
                ))}
            </div>
          )}
          <div className="security-panel__spacing">
            <button className="security-panel__action-btn" onClick={loadSecurityData}>
              刷新日志
            </button>
          </div>
        </div>

        <div className="security-panel__section">
          <div className="security-panel__section-title">数据主权</div>
          <div className="security-panel__sovereignty-grid">
            {sovereigntyItems.map((item, i) => (
              <div key={i} className="security-panel__sovereignty-item">
                <div className="security-panel__sovereignty-value">{item.value}</div>
                <div className="security-panel__sovereignty-label">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
