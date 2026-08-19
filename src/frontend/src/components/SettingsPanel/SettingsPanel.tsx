/**
 * 设置面板 v3 - LLM 多模型管理
 * 使用 base-panel.css 通用类库 + Toast 通知
 */
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../api/apiService';
import { useI18n } from '../../contexts/I18nContext';
import { useToast } from '../../contexts/ToastContext';
import { LOCALE_LABELS, type Locale } from '../../i18n';
import { useVoiceStore } from '../../stores/useVoiceStore';
import './SettingsPanel.css';

interface ModelCapability {
  visionScore: number;
  codingScore: number;
  reasoningScore: number;
  speedScore: number;
  contextLength: number;
  features: string[];
}

interface ModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
  priority: number;
  capabilities: ModelCapability;
}

interface ModelHealthEntry {
  available: boolean;
  lastError?: string;
}

interface LLMStatus {
  available: boolean;
  currentModel: string;
  health: Record<string, ModelHealthEntry>;
  availableModels: ModelInfo[];
}

function asLLMStatus(data: unknown): LLMStatus {
  return data as LLMStatus;
}

const SettingsPanel: React.FC = () => {
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const { showSuccess, showError } = useToast();
  const { locale, setLocale, t } = useI18n();
  const { settings: voiceSettings, updateSettings: updateVoiceSettings } = useVoiceStore();

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiService.getModelStatus();
      if (result.success && result.data) {
        const status = asLLMStatus(result.data);
        setLlmStatus(status);
      } else {
        showError(result.error || '获取模型状态失败');
      }
    } catch (e) {
      setLlmStatus(null);
      showError(`获取模型状态失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSwitchModel = useCallback(
    async (modelId: string) => {
      setSwitchingId(modelId);
      try {
        const result = await apiService.switchModel(modelId);
        if (result.success && result.data) {
          const status = asLLMStatus(result.data);
          setLlmStatus(status);
          showSuccess('模型切换成功，已即时生效');
        } else {
          showError(`切换失败: ${result.error || '未知错误'}`);
        }
      } catch (e) {
        showError(`网络错误: ${(e as Error).message}`);
      } finally {
        setSwitchingId(null);
      }
    },
    [showSuccess, showError]
  );

  const handleToggleEnabled = useCallback(
    async (modelId: string, enabled: boolean) => {
      setSwitchingId(modelId);
      try {
        const result = await apiService.switchModel(modelId, enabled ? '启用' : '禁用');
        if (result.success && result.data) {
          const status = asLLMStatus(result.data);
          setLlmStatus(status);
          showSuccess(enabled ? '模型已启用' : '模型已禁用');
        } else {
          showError(`操作失败: ${result.error || '未知错误'}`);
        }
      } catch (e) {
        showError(`操作失败: ${(e as Error).message}`);
      } finally {
        setSwitchingId(null);
      }
    },
    [showSuccess, showError]
  );

  const handleHealthCheck = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiService.getModelHealth();
      if (result.success) {
        showSuccess('健康检查完成');
      } else {
        showError(result.error || '健康检查失败');
      }
    } catch (e) {
      showError(`健康检查失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [showSuccess, showError]);

  const currentModelInfo = llmStatus?.availableModels.find((m) => m.priority === 1);

  const renderCapabilityBar = (label: string, score: number) => (
    <div key={label} className="settings-capability">
      <span className="settings-capability__label">{label}</span>
      <div className="gauge">
        <div className="gauge-fill" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <span className="settings-capability__score">{score}</span>
    </div>
  );

  return (
    <div className="panel-container settings-panel">
      <header className="panel-header">
        <h2 className="panel-title">LLM 模型管理</h2>
        <p className="panel-subtitle">多模型热切换 · 本地+云端双架构 · 无需重启</p>
      </header>

      {/* 当前活跃模型 */}
      <section className="function-node">
        <h3 className="section-title section-title--large">当前活跃模型</h3>
        {loading && !currentModelInfo ? (
          <div className="loading-msg">
            <span className="spinner" /> 加载中...
          </div>
        ) : currentModelInfo ? (
          <div className="settings-active-model">
            <div className="settings-active-model__header">
              <span className={`badge ${currentModelInfo.available ? 'badge--success' : 'badge--danger'}`}>
                {currentModelInfo.available ? '在线' : '离线'}
              </span>
              <span className="settings-active-model__name">{currentModelInfo.name}</span>
            </div>
            <div className="settings-active-model__tags">
              {currentModelInfo.capabilities.features.map((f) => (
                <span key={f} className="tag tag--active">
                  {f}
                </span>
              ))}
              <span className="tag">{currentModelInfo.capabilities.contextLength.toLocaleString()} tokens</span>
            </div>
          </div>
        ) : (
          <div className="empty-hint">无可用模型</div>
        )}
      </section>

      {/* 模型列表 */}
      <section className="section">
        <h3 className="section-title section-title--large">已注册模型</h3>
        {loading && !llmStatus ? (
          <div className="loading-msg">
            <span className="spinner" /> 加载模型列表...
          </div>
        ) : llmStatus?.availableModels && llmStatus.availableModels.length > 0 ? (
          <div className="settings-model-list">
            {llmStatus.availableModels.map((model) => (
              <div
                key={model.id}
                className={`function-node settings-model-card ${model.priority === 1 ? 'settings-model-card--active' : ''}`}
              >
                <div className="settings-model-card__header">
                  <div className="settings-model-card__info">
                    <span className={`badge ${model.available ? 'badge--success' : 'badge--danger'}`}>
                      {model.available ? '在线' : '离线'}
                    </span>
                    <span className="settings-model-card__name">{model.name}</span>
                    {model.priority === 1 && <span className="badge badge--info">活跃</span>}
                  </div>
                  <span className="tag">{model.id}</span>
                </div>

                <div className="settings-model-card__capabilities">
                  {renderCapabilityBar('代码', model.capabilities.codingScore)}
                  {renderCapabilityBar('推理', model.capabilities.reasoningScore)}
                  {renderCapabilityBar('速度', model.capabilities.speedScore)}
                </div>

                <div className="action-bar action-bar--right">
                  {model.priority !== 1 && model.available && (
                    <button
                      className="btn btn--primary"
                      onClick={() => handleSwitchModel(model.id)}
                      disabled={switchingId === model.id || loading}
                    >
                      {switchingId === model.id ? <span className="spinner" /> : null}
                      {switchingId === model.id ? '切换中...' : '切换到此模型'}
                    </button>
                  )}
                  <button
                    className={`btn ${model.enabled ? 'btn--danger' : 'btn--success'}`}
                    onClick={() => handleToggleEnabled(model.id, !model.enabled)}
                    disabled={switchingId === model.id || loading}
                  >
                    {model.enabled ? '禁用' : '启用'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-hint">暂无模型数据</div>
        )}
      </section>

      {/* 全局操作 */}
      <section className="subgroup">
        <div className="action-bar">
          <button className="btn" onClick={handleHealthCheck} disabled={loading}>
            {loading ? <span className="spinner" /> : null}
            重新健康检查
          </button>
          <button className="btn btn--primary" onClick={fetchStatus} disabled={loading}>
            刷新状态
          </button>
        </div>
      </section>

      {/* 国际化 & 语音 */}
      <section className="section">
        <h3 className="section-title">{t('settings.voice')}</h3>
        <div className="subgroup">
          <div className="settings-row">
            <span className="settings-label">{t('settings.language')}</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)} className="settings-select">
              {Object.entries(LOCALE_LABELS).map(([code, label]: [string, string]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-label">语音语言</span>
            <select
              value={voiceSettings.language}
              onChange={(e) => updateVoiceSettings({ language: e.target.value })}
              className="settings-select"
            >
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-label">TTS 语速</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={voiceSettings.ttsRate}
              onChange={(e) => updateVoiceSettings({ ttsRate: parseFloat(e.target.value) })}
              className="settings-range"
            />
            <span className="settings-value">{voiceSettings.ttsRate.toFixed(1)}x</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">{t('settings.autoSpeak')}</span>
            <input
              type="checkbox"
              checked={voiceSettings.autoSpeak}
              onChange={(e) => updateVoiceSettings({ autoSpeak: e.target.checked })}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">{t('settings.continuousMode')}</span>
            <input
              type="checkbox"
              checked={voiceSettings.continuousMode}
              onChange={(e) => updateVoiceSettings({ continuousMode: e.target.checked })}
            />
          </div>
        </div>
      </section>

      {/* 关于 */}
      <section className="section">
        <h3 className="section-title">关于</h3>
        <div className="subgroup">
          <p className="settings-version">家百星 v2.0 — 多模型智能路由</p>
          <p className="settings-desc">
            本地 LLM Server + 云端 API 双模型架构。系统自动优先使用本地模型，不可用时自动降级到云端。
            切换模型即时生效，无需重启服务。
          </p>
        </div>
      </section>
    </div>
  );
};

export default SettingsPanel;
