import React, { useEffect, useRef, useState } from 'react';
import { useIntegrationStore } from '../../stores/useIntegrationStore';
import { IntegrationPlatform, PlatformConfig } from '@shared/contracts';
import { apiService } from '../../api/apiService';
import './IntegrationPanel.css';

const PLATFORM_DISPLAY_NAMES: Record<IntegrationPlatform, string> = {
  wechat: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  qq: 'QQ',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  signal: 'Signal',
};

const PLATFORM_ICONS: Record<IntegrationPlatform, string> = {
  wechat: '💬',
  feishu: '✈️',
  dingtalk: '🔔',
  qq: '🐧',
  telegram: '✈️',
  discord: '🎮',
  slack: '📱',
  signal: '🔒',
};

interface PlatformConfigFormProps {
  platform: IntegrationPlatform;
  onConnect: (config: PlatformConfig) => void;
  onCancel: () => void;
}

const PlatformConfigForm: React.FC<PlatformConfigFormProps> = ({ platform, onConnect, onCancel }) => {
  const [config, setConfig] = useState<PlatformConfig>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect(config);
  };

  const renderConfigFields = () => {
    switch (platform) {
      case 'wechat':
        return (
          <>
            <div className="form-group">
              <label>连接方式</label>
              <div className="mode-selector">
                <label className="mode-option">
                  <input
                    type="radio"
                    name="wechatMode"
                    value="qr"
                    checked={config.mode === 'qr'}
                    onChange={() => setConfig({ ...config, mode: 'qr' })}
                  />
                  <span>📱 扫码登录（个人微信）</span>
                </label>
                <label className="mode-option">
                  <input
                    type="radio"
                    name="wechatMode"
                    value="official"
                    checked={config.mode !== 'qr'}
                    onChange={() => setConfig({ ...config, mode: 'official' })}
                  />
                  <span>🏢 企业号/公众号</span>
                </label>
              </div>
            </div>
            {config.mode === 'qr' ? (
              <div className="qr-mode-hint">
                <p>点击"连接"后，将打开微信网页版</p>
                <p>请用手机微信扫描屏幕上的二维码</p>
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="wechatAppId">AppID</label>
                  <input
                    id="wechatAppId"
                    type="text"
                    value={config.appId || ''}
                    onChange={(e) => setConfig({ ...config, appId: e.target.value })}
                    placeholder="输入微信AppID"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="wechatAppSecret">AppSecret</label>
                  <input
                    id="wechatAppSecret"
                    type="password"
                    value={config.appSecret || ''}
                    onChange={(e) => setConfig({ ...config, appSecret: e.target.value })}
                    placeholder="输入微信AppSecret"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="wechatToken">Token</label>
                  <input
                    id="wechatToken"
                    type="text"
                    value={config.token || ''}
                    onChange={(e) => setConfig({ ...config, token: e.target.value })}
                    placeholder="输入微信Token"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="wechatEncodingAESKey">EncodingAESKey</label>
                  <input
                    id="wechatEncodingAESKey"
                    type="text"
                    value={config.encodingAESKey || ''}
                    onChange={(e) => setConfig({ ...config, encodingAESKey: e.target.value })}
                    placeholder="输入EncodingAESKey"
                  />
                </div>
              </>
            )}
          </>
        );

      case 'feishu':
        return (
          <>
            <div className="form-group">
              <label htmlFor="feishuAppId">App ID</label>
              <input
                id="feishuAppId"
                type="text"
                value={config.appId || ''}
                onChange={(e) => setConfig({ ...config, appId: e.target.value })}
                placeholder="输入飞书App ID"
              />
            </div>
            <div className="form-group">
              <label htmlFor="feishuAppSecret">App Secret</label>
              <input
                id="feishuAppSecret"
                type="password"
                value={config.appSecret || ''}
                onChange={(e) => setConfig({ ...config, appSecret: e.target.value })}
                placeholder="输入飞书App Secret"
              />
            </div>
            <div className="form-group">
              <label htmlFor="feishuVerificationToken">Verification Token</label>
              <input
                id="feishuVerificationToken"
                type="text"
                value={config.verificationToken || ''}
                onChange={(e) => setConfig({ ...config, verificationToken: e.target.value })}
                placeholder="输入Verification Token"
              />
            </div>
            <div className="form-group">
              <label htmlFor="feishuEncryptKey">Encrypt Key</label>
              <input
                id="feishuEncryptKey"
                type="text"
                value={config.encryptKey || ''}
                onChange={(e) => setConfig({ ...config, encryptKey: e.target.value })}
                placeholder="输入Encrypt Key（可选）"
              />
            </div>
          </>
        );

      case 'dingtalk':
        return (
          <>
            <div className="form-group">
              <label htmlFor="dingtalkClientId">Client ID</label>
              <input
                id="dingtalkClientId"
                type="text"
                value={config.clientId || ''}
                onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
                placeholder="输入钉钉Client ID"
              />
            </div>
            <div className="form-group">
              <label htmlFor="dingtalkClientSecret">Client Secret</label>
              <input
                id="dingtalkClientSecret"
                type="password"
                value={config.clientSecret || ''}
                onChange={(e) => setConfig({ ...config, clientSecret: e.target.value })}
                placeholder="输入钉钉Client Secret"
              />
            </div>
            <div className="form-group">
              <label htmlFor="dingtalkSignatureSecret">签名密钥</label>
              <input
                id="dingtalkSignatureSecret"
                type="text"
                value={config.signatureSecret || ''}
                onChange={(e) => setConfig({ ...config, signatureSecret: e.target.value })}
                placeholder="输入签名密钥（可选）"
              />
            </div>
          </>
        );

      case 'qq':
        return (
          <>
            <div className="form-group">
              <label htmlFor="qqMiraiHost">Mirai HTTP 地址</label>
              <input
                id="qqMiraiHost"
                type="text"
                value={config.miraiHttpHost || 'localhost'}
                onChange={(e) => setConfig({ ...config, miraiHttpHost: e.target.value })}
                placeholder="默认 localhost"
              />
            </div>
            <div className="form-group">
              <label htmlFor="qqMiraiPort">Mirai HTTP 端口</label>
              <input
                id="qqMiraiPort"
                type="text"
                value={config.miraiHttpPort || '8080'}
                onChange={(e) => setConfig({ ...config, miraiHttpPort: e.target.value })}
                placeholder="默认 8080"
              />
            </div>
            <div className="form-group">
              <label htmlFor="qqVerifyKey">Mirai VerifyKey</label>
              <input
                id="qqVerifyKey"
                type="password"
                value={config.miraiVerifyKey || ''}
                onChange={(e) => setConfig({ ...config, miraiVerifyKey: e.target.value })}
                placeholder="输入 Mirai verifyKey"
              />
            </div>
            <div className="form-group">
              <label htmlFor="qqAccount">QQ 账号</label>
              <input
                id="qqAccount"
                type="text"
                value={config.qqAccount || ''}
                onChange={(e) => setConfig({ ...config, qqAccount: e.target.value })}
                placeholder="输入机器人 QQ 号"
              />
            </div>
            <div className="form-group">
              <label htmlFor="qqPassword">QQ 密码（可选）</label>
              <input
                id="qqPassword"
                type="password"
                value={config.qqPassword || ''}
                onChange={(e) => setConfig({ ...config, qqPassword: e.target.value })}
                placeholder="输入 QQ 密码（部分环境需要）"
              />
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <form className="platform-config-form" onSubmit={handleSubmit}>
      <h4>配置 {PLATFORM_DISPLAY_NAMES[platform]}</h4>
      {renderConfigFields()}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">
          连接
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
};

const IntegrationPanel: React.FC = () => {
  const {
    platforms,
    platformStatuses,
    messages,
    isLoading,
    error,
    fetchPlatforms,
    fetchPlatformStatus,
    connectPlatform,
    disconnectPlatform,
    clearMessages,
  } = useIntegrationStore();

  const [selectedPlatform, setSelectedPlatform] = useState<IntegrationPlatform | null>(null);
  const [showConfigForm, setShowConfigForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'platforms' | 'messages'>('platforms');
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState<string>('');
  const qrPollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchPlatforms();
  }, [fetchPlatforms]);

  useEffect(() => {
    platforms.forEach((platform) => {
      fetchPlatformStatus(platform.id);
    });
  }, [platforms, fetchPlatformStatus]);

  const handleConnect = async (platform: IntegrationPlatform, config: PlatformConfig) => {
    await connectPlatform(platform, config);
    setShowConfigForm(false);
    setSelectedPlatform(null);

    // 微信 QR 扫码模式：开始轮询二维码
    if (platform === 'wechat' && config.mode === 'qr') {
      setQrCodeData(null);
      setQrStatus('connecting');
      startQRPolling();
    }
  };

  const startQRPolling = () => {
    if (qrPollRef.current) clearInterval(qrPollRef.current);
    qrPollRef.current = setInterval(async () => {
      try {
        const result = await apiService.getWeChatQRCode();
        if (result.success && result.data) {
          const data = result.data as Record<string, unknown>;
          if (data.qrCodeBase64) {
            setQrCodeData(data.qrCodeBase64 as string);
          }
          setQrStatus(data.status as string);
          if (data.status === 'logged_in') {
            setQrStatus('已登录: ' + ((data.botNickname as string) || ''));
            if (qrPollRef.current) clearInterval(qrPollRef.current);
          }
        }
      } catch {}
    }, 2000);
  };

  useEffect(() => {
    return () => {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
    };
  }, []);

  const handleDisconnect = async (platform: IntegrationPlatform) => {
    if (confirm(`确定要断开 ${PLATFORM_DISPLAY_NAMES[platform]} 连接吗？`)) {
      await disconnectPlatform(platform);
    }
  };

  const getStatusBadge = (platform: IntegrationPlatform) => {
    const status = platformStatuses.get(platform);
    if (!status) {
      return <span className="badge badge-unknown">未知</span>;
    }

    const statusConfig = {
      connected: { class: 'badge-connected', text: '已连接' },
      connecting: { class: 'badge-connecting', text: '连接中...' },
      disconnected: { class: 'badge-disconnected', text: '未连接' },
      error: { class: 'badge-error', text: '错误' },
    };

    const config = statusConfig[status.status as keyof typeof statusConfig] || statusConfig.disconnected;

    return (
      <>
        <span className={`badge ${config.class}`}>{config.text}</span>
        {status.status === 'connected' && status.lastConnectedAt && (
          <span className="last-connected">{new Date(status.lastConnectedAt).toLocaleString('zh-CN')}</span>
        )}
        {status.error && <span className="error-message">{status.error}</span>}
      </>
    );
  };

  return (
    <div className="integration-panel">
      <div className="panel-header">
        <h2>🤝 集成管理</h2>
        <div className="tab-buttons">
          <button
            className={`tab-button ${activeTab === 'platforms' ? 'active' : ''}`}
            onClick={() => setActiveTab('platforms')}
          >
            平台管理
          </button>
          <button
            className={`tab-button ${activeTab === 'messages' ? 'active' : ''}`}
            onClick={() => setActiveTab('messages')}
          >
            消息日志 ({messages.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>⚠️ {error}</span>
          <button onClick={() => useIntegrationStore.setState({ error: null })}>关闭</button>
        </div>
      )}

      {activeTab === 'platforms' ? (
        <div className="platforms-grid">
          {platforms.map((platform) => {
            const status = platformStatuses.get(platform.id);
            const isConnected = status?.status === 'connected';

            return (
              <div key={platform.id} className="platform-card">
                <div className="platform-header">
                  <div className="platform-icon">{PLATFORM_ICONS[platform.id]}</div>
                  <div className="platform-info">
                    <h3>{platform.name}</h3>
                    {getStatusBadge(platform.id)}
                  </div>
                </div>

                <div className="platform-description">{platform.description}</div>

                {platform.id === 'wechat' && qrCodeData && (
                  <div className="qr-code-display">
                    <h4>📱 微信扫码登录</h4>
                    <img src={qrCodeData} alt="微信二维码" className="qr-image" />
                    <p className="qr-status">
                      {qrStatus === 'waiting_scan' && '请用手机微信扫描二维码'}
                      {qrStatus === 'connecting' && '正在生成二维码...'}
                      {qrStatus === 'scanned' && '✅ 已扫描，请在手机上确认登录'}
                      {qrStatus === 'logged_in' && '✅ 已登录'}
                      {qrStatus === 'expired' && '二维码已过期，请重新连接'}
                      {!['waiting_scan', 'connecting', 'scanned', 'logged_in', 'expired'].includes(qrStatus) &&
                        qrStatus}
                    </p>
                  </div>
                )}

                <div className="platform-actions">
                  {!isConnected ? (
                    <>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setSelectedPlatform(platform.id);
                          setShowConfigForm(true);
                        }}
                        disabled={isLoading}
                      >
                        连接
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-success" disabled>
                        ✓ 已连接
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => handleDisconnect(platform.id)}
                        disabled={isLoading}
                      >
                        断开
                      </button>
                    </>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() => fetchPlatformStatus(platform.id)}
                    disabled={isLoading}
                  >
                    刷新
                  </button>
                </div>

                {showConfigForm && selectedPlatform === platform.id && (
                  <PlatformConfigForm
                    platform={platform.id}
                    onConnect={(config) => handleConnect(platform.id, config)}
                    onCancel={() => {
                      setShowConfigForm(false);
                      setSelectedPlatform(null);
                    }}
                  />
                )}

                {platform.features && platform.features.length > 0 && (
                  <div className="platform-features">
                    <h4>支持的功能:</h4>
                    <ul>
                      {platform.features.map((feature, index) => (
                        <li key={index}>{feature}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="messages-panel">
          <div className="messages-header">
            <h3>消息日志</h3>
            <button className="btn btn-secondary" onClick={clearMessages}>
              清空日志
            </button>
          </div>

          {messages.length === 0 ? (
            <div className="empty-state">
              <p>暂无消息记录</p>
              <p className="hint">当有平台连接并收到消息时，这里会显示日志</p>
            </div>
          ) : (
            <div className="messages-list">
              {messages.map((msg) => (
                <div key={msg.id} className={`message-item ${msg.direction === 'incoming' ? 'incoming' : 'outgoing'}`}>
                  <div className="message-header">
                    <span className="message-platform">
                      {PLATFORM_ICONS[msg.platform]} {PLATFORM_DISPLAY_NAMES[msg.platform]}
                    </span>
                    <span className="message-type">[{msg.type}]</span>
                    <span className="message-time">{new Date(msg.timestamp).toLocaleString('zh-CN')}</span>
                  </div>
                  <div className="message-content">{msg.content}</div>
                  {msg.from && <div className="message-sender">来自: {msg.fromName || msg.from}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading && (
        <div className="loading-overlay">
          <div className="spinner"></div>
          <span>加载中...</span>
        </div>
      )}
    </div>
  );
};

export default IntegrationPanel;
