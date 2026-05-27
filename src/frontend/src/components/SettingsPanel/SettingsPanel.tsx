/**
 * 设置面板 v2 - LLM 多模型管理（支持热切换，无需重启）
 */
import React, { useCallback, useEffect, useState } from 'react';
import './SettingsPanel.css';
import { apiService } from '../../api/apiService';

interface ModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
  priority: number;
  capabilities: {
    visionScore: number;
    codingScore: number;
    reasoningScore: number;
    speedScore: number;
    contextLength: number;
    features: string[];
  };
}

interface LLMStatus {
  available: boolean;
  currentModel: string;
  health: Record<string, { available: boolean; lastError?: string }>;
  availableModels: ModelInfo[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

const SettingsPanel: React.FC<Props> = ({ visible, onClose }) => {
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiService.getModelStatus();
      if (result.success && result.data) {
        setLlmStatus(result.data as unknown as LLMStatus);
      }
    } catch {
      setLlmStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      fetchStatus();
    }
  }, [visible, fetchStatus]);

  const _handleSwitchModel = useCallback(async (modelId: string) => {
    setSwitching(modelId);
    setMessage('');
    try {
      const result = await apiService.switchModel(modelId);
      if (result.success && result.data) {
        setLlmStatus(result.data as unknown as LLMStatus);
        setMessage('切换成功，已即时生效');
      } else {
        setMessage(`切换失败: ${result.error || '未知错误'}`);
      }
    } catch (e) {
      setMessage(`网络错误: ${(e as Error).message}`);
    } finally {
      setSwitching(null);
    }
  }, []);

  const _handleToggleEnabled = useCallback(async (modelId: string, enabled: boolean) => {
    setSwitching(modelId);
    setMessage('');
    try {
      const result = await apiService.switchModel(modelId, enabled ? '启用' : '禁用');
      if (result.success && result.data) {
        setLlmStatus(result.data as unknown as LLMStatus);
        setMessage(enabled ? '模型已启用' : '模型已禁用');
      }
    } catch (e) {
      setMessage(`操作失败: ${(e as Error).message}`);
    } finally {
      setSwitching(null);
    }
  }, []);

  const _handleHealthCheck = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const result = await apiService.getModelHealth();
      if (result.success && result.data) {
        setMessage('健康检查完成');
      }
    } catch (e) {
      setMessage(`健康检查失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  if (!visible) return null;

  const currentModelInfo = llmStatus?.availableModels.find((m) => m.priority === 1);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>⚙️ LLM 模型管理</h2>
          <button className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* 当前活跃模型 */}
          <section className="settings-section">
            <h3>当前活跃模型</h3>
            <div className="active-model-card">
              {loading ? (
                <p className="loading-hint">加载中...</p>
              ) : currentModelInfo ? (
                <div className="active-model-info">
                  <div className="active-model-name">
                    <span className={`status-dot ${currentModelInfo.available ? 'online' : 'offline'}`} />
                    {currentModelInfo.name}
                  </div>
                  <div className="active-model-tags">
                    {currentModelInfo.capabilities.features.map((f) => (
                      <span key={f} className="model-tag">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="loading-hint">无可用模型</p>
              )}
            </div>
          </section>

          {/* 模型列表 */}
          <section className="settings-section">
            <h3>已注册模型</h3>
            {llmStatus?.availableModels && llmStatus.availableModels.length > 0 ? (
              <div className="model-list">
                {llmStatus.availableModels.map((model) => (
                  <div
                    key={model.id}
                    className={`model-card ${
                      model.priority === 1 ? 'active' : ''
                    } ${!model.available ? 'unavailable' : ''}`}
                  >
                    <div className="model-card-header">
                      <span className={`status-dot ${model.available ? 'online' : 'offline'}`} />
                      <span className="model-name">
                        {model.name}
                        {model.priority === 1 && <span className="active-badge">活跃</span>}
                      </span>
                      <span className="model-id-tag">{model.id}</span>
                    </div>

                    <div className="model-capabilities">
                      <div className="cap-row">
                        <span>代码</span>
                        <div className="cap-bar-bg">
                          <div
                            className="cap-bar-fill"
                            style={{
                              width: `${model.capabilities.codingScore}%`,
                            }}
                          />
                        </div>
                        <span>{model.capabilities.codingScore}</span>
                      </div>
                      <div className="cap-row">
                        <span>推理</span>
                        <div className="cap-bar-bg">
                          <div
                            className="cap-bar-fill"
                            style={{
                              width: `${model.capabilities.reasoningScore}%`,
                            }}
                          />
                        </div>
                        <span>{model.capabilities.reasoningScore}</span>
                      </div>
                      <div className="cap-row">
                        <span>速度</span>
                        <div className="cap-bar-bg">
                          <div
                            className="cap-bar-fill"
                            style={{
                              width: `${model.capabilities.speedScore}%`,
                            }}
                          />
                        </div>
                        <span>{model.capabilities.speedScore}</span>
                      </div>
                    </div>

                    <div className="model-actions">
                      {model.priority !== 1 && model.available && (
                        <button
                          className="action-btn switch-btn"
                          onClick={() => _handleSwitchModel(model.id)}
                          disabled={switching === model.id}
                        >
                          {switching === model.id ? '切换中...' : '切换到此模型'}
                        </button>
                      )}
                      <button
                        className={`action-btn ${model.enabled ? 'disable-btn' : 'enable-btn'}`}
                        onClick={() => _handleToggleEnabled(model.id, !model.enabled)}
                        disabled={switching === model.id}
                      >
                        {switching === model.id ? '...' : model.enabled ? '禁用' : '启用'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="loading-hint">{loading ? '加载中...' : '暂无模型'}</p>
            )}
          </section>

          {/* 操作 */}
          <section className="settings-section">
            <div className="settings-actions">
              <button className="action-btn health-btn" onClick={_handleHealthCheck} disabled={loading}>
                {loading ? '检查中...' : '重新健康检查'}
              </button>
              <button className="action-btn refresh-btn" onClick={fetchStatus} disabled={loading}>
                刷新状态
              </button>
            </div>
            {message && <p className="settings-message">{message}</p>}
          </section>

          {/* 关于 */}
          <section className="settings-section">
            <h3>关于</h3>
            <div className="settings-info">
              <p className="settings-version">家百星 v2.0 — 多模型智能路由</p>
              <p className="settings-desc">
                本地 LLM.Server + 云端智谱 API 双模型架构。系统自动优先使用本地模型，不可用时自动降级到云端。
                点击"切换到此模型"可即时切换活跃模型，无需重启。
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
