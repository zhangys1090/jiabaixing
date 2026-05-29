import React, { useCallback, useState } from 'react';
import './DesktopPanel.css';
import { useDesktopStore } from '../../stores/useDesktopStore';

const API_BASE = (window as unknown as Record<string, string>).REACT_APP_API_URL || `http://${window.location.hostname}:3111`;

export const DesktopPanel: React.FC = () => {
  const {
    screenshot,
    ocrResult,
    actionHistory,
    isRunning,
    safeMode,
    setScreenshot,
    setOcrResult,
    addAction,
    setIsRunning,
    setSafeMode,
  } = useDesktopStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScreenshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    addAction({ type: 'screenshot', detail: '屏幕截图', timestamp: Date.now() });
    try {
      const resp = await fetch(`${API_BASE}/api/desktop/screenshot`, { method: 'POST' });
      const data = await resp.json();
      if (data.success && data.data?.screenshot) {
        setScreenshot(data.data.screenshot);
      } else {
        setError(data.error || '截图失败');
      }
    } catch (e) {
      setError(`截图失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [addAction, setScreenshot]);

  const handleOcr = useCallback(() => {
    if (!screenshot) return;
    setLoading(true);
    setError(null);
    addAction({ type: 'ocr', detail: 'OCR识别', timestamp: Date.now() });
    // OCR 后端未实现，保留前端模拟作为降级
    setTimeout(() => {
      setOcrResult(['（OCR后端未实现，此为降级显示）']);
      setLoading(false);
    }, 500);
  }, [screenshot, setOcrResult, addAction]);

  const handleUiCheck = useCallback(async () => {
    if (!screenshot) return;
    setLoading(true);
    setError(null);
    addAction({ type: 'click', detail: 'UI检查', timestamp: Date.now() });
    try {
      const resp = await fetch(`${API_BASE}/api/desktop/automate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: '检查当前桌面UI元素布局' }),
      });
      const data = await resp.json();
      if (data.success) {
        addAction({ type: 'click', detail: `UI检查: ${String(data.data?.output || '').substring(0, 80)}`, timestamp: Date.now() });
      }
    } catch {
      // 静默降级
    } finally {
      setLoading(false);
    }
  }, [screenshot, addAction]);

  const handleStartLoop = useCallback(() => {
    setIsRunning(true);
    addAction({
      type: 'click',
      detail: '启动桌面代理循环',
      timestamp: Date.now(),
    });
  }, [setIsRunning, addAction]);

  const handleStopLoop = useCallback(() => {
    setIsRunning(false);
    addAction({
      type: 'click',
      detail: '停止桌面代理循环',
      timestamp: Date.now(),
    });
  }, [setIsRunning, addAction]);

  const formatTime = (timestamp: number): string => {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return `${diff}秒前`;
    return `${Math.floor(diff / 60)}分钟前`;
  };

  return (
    <div className="desktop-panel">
      <div className="desktop-panel__section">
        <div className="desktop-panel__section-title">屏幕截图</div>
        <div className="desktop-panel__screenshot-area">
          {screenshot ? (
            <img className="desktop-panel__screenshot-image" src={screenshot} alt="桌面截图" />
          ) : error ? (
            <div className="desktop-panel__error">{error}</div>
          ) : (
            '点击截图按钮获取屏幕截图'
          )}
        </div>
        <div className="desktop-panel__action-row">
          <button className="desktop-panel__action-button" onClick={handleScreenshot} disabled={loading}>
            📸 截图
          </button>
          <button className="desktop-panel__action-button" onClick={handleOcr} disabled={loading || !screenshot}>
            🔤 OCR识别
          </button>
          <button className="desktop-panel__action-button" onClick={handleUiCheck} disabled={loading || !screenshot}>
            🔍 UI检查
          </button>
        </div>
      </div>

      {ocrResult.length > 0 && (
        <div className="desktop-panel__section">
          <div className="desktop-panel__section-title">OCR结果</div>
          <div className="desktop-panel__ocr-result">
            {ocrResult.map((text, i) => (
              <span className="desktop-panel__ocr-tag" key={i}>
                {text}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="desktop-panel__section">
        <div className="desktop-panel__section-title">操作历史</div>
        {actionHistory.length === 0 ? (
          <div className="desktop-panel__empty-hint">暂无操作记录</div>
        ) : (
          <div className="desktop-panel__action-history">
            {actionHistory
              .slice(-5)
              .reverse()
              .map((action, i) => (
                <div className="desktop-panel__history-item" key={i}>
                  <span className="desktop-panel__history-action">
                    {action.type === 'click' && '🖱 '}
                    {action.type === 'type' && '⌨️ '}
                    {action.type === 'screenshot' && '📸 '}
                    {action.type === 'ocr' && '🔤 '}
                    {action.detail}
                  </span>
                  <span className="desktop-panel__history-time">{formatTime(action.timestamp)}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="desktop-panel__section">
        <div className="desktop-panel__section-title">代理控制</div>
        <div className="desktop-panel__toggle-row">
          <span className="desktop-panel__toggle-label">安全模式</span>
          <label className="desktop-panel__toggle">
            <input
              className="desktop-panel__toggle-input"
              type="checkbox"
              checked={safeMode}
              onChange={(e) => setSafeMode(e.target.checked)}
            />
            <span
              className={`desktop-panel__toggle-slider${safeMode ? ' desktop-panel__toggle-slider--checked' : ''}`}
            />
          </label>
        </div>
        <div className="desktop-panel__action-row">
          {!isRunning ? (
            <button
              className="desktop-panel__action-button desktop-panel__action-button--primary"
              onClick={handleStartLoop}
            >
              ▶ 启动代理循环
            </button>
          ) : (
            <button
              className="desktop-panel__action-button desktop-panel__action-button--danger"
              onClick={handleStopLoop}
            >
              ⏹ 停止
            </button>
          )}
        </div>
        <div className="desktop-panel__spacing">
          <span
            className={`desktop-panel__status-indicator${isRunning ? ' desktop-panel__status-indicator--running' : ''}`}
          >
            {isRunning ? '运行中' : '已停止'}
          </span>
        </div>
      </div>

      <div className="desktop-panel__section">
        <div className="desktop-panel__section-title">撤销管理</div>
        <div className="desktop-panel__undo-row">
          <button className="desktop-panel__action-button" disabled={actionHistory.length === 0}>
            撤销上一步
          </button>
          <button className="desktop-panel__action-button" disabled={actionHistory.length === 0}>
            撤销全部
          </button>
          <button className="desktop-panel__action-button" disabled>
            快照列表
          </button>
        </div>
      </div>
    </div>
  );
};
