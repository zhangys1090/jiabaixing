import React, { useCallback, useState } from 'react';
import './DesktopPanel.css';
import { useDesktopStore } from '../../stores/useDesktopStore';

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

  const handleScreenshot = useCallback(() => {
    setLoading(true);
    addAction({
      type: 'screenshot',
      detail: '屏幕截图',
      timestamp: Date.now(),
    });
    setScreenshot(
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTUwIj48cmVjdCBmaWxsPSIjMjIyMjQ2IiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjE1MCIvPjx0ZXh0IGZpbGw9IiM2MDYwYTAiIHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5zY3JlZW5zaG90PC90ZXh0Pjwvc3ZnPg=='
    );
    setLoading(false);
  }, [addAction, setScreenshot]);

  const handleOcr = useCallback(() => {
    if (!screenshot) return;
    setLoading(true);
    setTimeout(() => {
      setOcrResult(['文件', '编辑', '查看', '项目', '终端', '帮助']);
      setLoading(false);
    }, 1000);
  }, [screenshot, setOcrResult]);

  const handleUiCheck = useCallback(() => {
    if (!screenshot) return;
    setLoading(true);
    addAction({
      type: 'click',
      detail: 'UI检查',
      timestamp: Date.now(),
    });
    setTimeout(() => {
      setLoading(false);
    }, 500);
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
          ) : (
            '点击"截图"按钮获取屏幕截图'
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
