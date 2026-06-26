/**
 * HermesPanel - Hermes 特性增强功能面板
 *
 * 集成 P0/P2 已接线组件的前端入口：
 * - 批处理引擎（Task 8）：并行运行多个 prompt，导出 ShareGPT/JSONL
 * - IDE 集成（Task 18）：ACP 协议聊天，查看活跃会话
 * - RL 轨迹导出（Task 19）：导出累积轨迹，查看统计
 * - 工具执行（P2）：图像生成 / 文本转语音 / 网页抓取
 */

import type { BatchResultItem, IdeSession, ToolExecuteResponse, TrajectoryStatsResponse } from '@shared/contracts';
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../api/apiService';
import './HermesPanel.css';

type HermesTab = 'batch' | 'ide' | 'trajectory' | 'tools';

function formatToolResult(result: { success: boolean; data?: ToolExecuteResponse; error?: string }): string {
  if (!result.success) {
    return `❌ ${result.error || '执行失败'}`;
  }
  if (!result.data) return '✅ 执行成功（无输出）';
  const d = result.data;
  if (!d.success) return `❌ ${d.error || '工具执行失败'}`;
  const meta = d.metadata || {};
  const duration = meta.duration ? `${meta.duration}ms` : '';
  const output = typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2);
  return `✅ ${output}${duration ? ` (${duration})` : ''}`;
}

export const HermesPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<HermesTab>('batch');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 批处理状态
  const [batchInput, setBatchInput] = useState('你好\n介绍一下自己\n计算 1+1');
  const [batchFormat, setBatchFormat] = useState<'sharegpt' | 'jsonl' | 'raw'>('raw');
  const [batchResults, setBatchResults] = useState<BatchResultItem[] | null>(null);
  const [batchRawOutput, setBatchRawOutput] = useState<string>('');

  // IDE 状态
  const [ideMessage, setIdeMessage] = useState('');
  const [ideSessionId, setIdeSessionId] = useState('');
  const [ideResponse, setIdeResponse] = useState<string>('');
  const [ideSessions, setIdeSessions] = useState<IdeSession[]>([]);

  // 轨迹状态
  const [trajectoryStats, setTrajectoryStats] = useState<TrajectoryStatsResponse | null>(null);
  const [trajectoryExport, setTrajectoryExport] = useState<string>('');

  // 工具状态（图像生成 / TTS / 网页抓取）
  const [imgPrompt, setImgPrompt] = useState('a cute cat sitting on a windowsill');
  const [imgSize, setImgSize] = useState('square');
  const [imgResult, setImgResult] = useState<string>('');
  const [ttsText, setTtsText] = useState('你好，欢迎使用家百星智能助手。');
  const [ttsVoice, setTtsVoice] = useState('default');
  const [ttsResult, setTtsResult] = useState<string>('');
  const [fetchUrl, setFetchUrl] = useState('https://example.com');
  const [fetchResult, setFetchResult] = useState<string>('');

  const handleRunBatch = useCallback(async () => {
    const prompts = batchInput
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `p${i + 1}`, text }));

    if (prompts.length === 0) {
      setError('请输入至少一个 prompt');
      return;
    }

    setLoading(true);
    setError(null);
    setBatchResults(null);
    setBatchRawOutput('');

    const result = await apiService.runBatch({
      prompts,
      outputFormat: batchFormat,
      config: { concurrency: 3, timeout: 60000 },
    });

    if (result.success && result.data) {
      const { format, data } = result.data;
      if (format === 'raw' && Array.isArray(data)) {
        setBatchResults(data);
      } else if (typeof data === 'string') {
        setBatchRawOutput(data);
      }
    } else {
      setError(result.error || '批处理失败');
    }
    setLoading(false);
  }, [batchInput, batchFormat]);

  const handleIdeChat = useCallback(async () => {
    if (!ideMessage.trim()) {
      setError('请输入消息');
      return;
    }

    setLoading(true);
    setError(null);
    setIdeResponse('');

    const result = await apiService.chatWithIde({
      message: ideMessage,
      sessionId: ideSessionId || undefined,
    });

    if (result.success && result.data) {
      setIdeResponse(result.data.content);
      setIdeSessionId(result.data.sessionId);
    } else {
      setError(result.error || 'IDE 聊天失败');
    }
    setLoading(false);
  }, [ideMessage, ideSessionId]);

  const loadIdeSessions = useCallback(async () => {
    const result = await apiService.getIdeSessions();
    if (result.success && result.data) {
      setIdeSessions(result.data);
    }
  }, []);

  const loadTrajectoryStats = useCallback(async () => {
    const result = await apiService.getTrajectoryStats();
    if (result.success && result.data) {
      setTrajectoryStats(result.data);
    }
  }, []);

  const handleExportTrajectory = useCallback(async (format: 'sharegpt' | 'jsonl' | 'openai_finetune') => {
    setLoading(true);
    setError(null);
    setTrajectoryExport('');

    const result = await apiService.exportTrajectories(format);
    if (result.success && result.data !== undefined) {
      const output = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      setTrajectoryExport(output.substring(0, 5000));
    } else {
      setError(result.error || '轨迹导出失败');
    }
    setLoading(false);
  }, []);

  const handleGenerateImage = useCallback(async () => {
    if (!imgPrompt.trim()) {
      setError('请输入图像描述');
      return;
    }
    setLoading(true);
    setError(null);
    setImgResult('');

    const result = await apiService.generateImage(imgPrompt, imgSize);
    setImgResult(formatToolResult(result));
    setLoading(false);
  }, [imgPrompt, imgSize]);

  const handleSpeakTts = useCallback(async () => {
    if (!ttsText.trim()) {
      setError('请输入文本内容');
      return;
    }
    setLoading(true);
    setError(null);
    setTtsResult('');

    const result = await apiService.speakTts(ttsText, ttsVoice);
    setTtsResult(formatToolResult(result));
    setLoading(false);
  }, [ttsText, ttsVoice]);

  const handleFetchWeb = useCallback(async () => {
    if (!fetchUrl.trim()) {
      setError('请输入 URL');
      return;
    }
    setLoading(true);
    setError(null);
    setFetchResult('');

    const result = await apiService.fetchWebPage(fetchUrl);
    setFetchResult(formatToolResult(result));
    setLoading(false);
  }, [fetchUrl]);

  useEffect(() => {
    if (activeTab === 'ide') loadIdeSessions();
    if (activeTab === 'trajectory' && !trajectoryStats) loadTrajectoryStats();
  }, [activeTab, trajectoryStats, loadIdeSessions, loadTrajectoryStats]);

  return (
    <div className="hermes-panel">
      <div className="hermes-panel__header">
        <h2 className="hermes-panel__title">⚡ Hermes 特性增强</h2>
        <p className="hermes-panel__subtitle">批处理 · IDE 集成 · RL 轨迹</p>
      </div>

      <div className="hermes-panel__tab-bar">
        <button
          className={`hermes-panel__tab${activeTab === 'batch' ? ' hermes-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('batch')}
        >
          📦 批处理
        </button>
        <button
          className={`hermes-panel__tab${activeTab === 'ide' ? ' hermes-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('ide')}
        >
          💻 IDE 集成
        </button>
        <button
          className={`hermes-panel__tab${activeTab === 'trajectory' ? ' hermes-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('trajectory')}
        >
          📈 RL 轨迹
        </button>
        <button
          className={`hermes-panel__tab${activeTab === 'tools' ? ' hermes-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          🛠 工具
        </button>
      </div>

      {error && <div className="hermes-panel__error">⚠ {error}</div>}
      {loading && <div className="hermes-panel__loading">处理中...</div>}

      <div className="hermes-panel__content">
        {activeTab === 'batch' && (
          <div className="hermes-panel__section">
            <label className="hermes-panel__label">Prompts（每行一个）</label>
            <textarea
              className="hermes-panel__textarea"
              rows={6}
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder="你好&#10;介绍一下自己&#10;计算 1+1"
            />

            <label className="hermes-panel__label">输出格式</label>
            <div className="hermes-panel__radio-group">
              {(['raw', 'sharegpt', 'jsonl'] as const).map((f) => (
                <label key={f} className="hermes-panel__radio">
                  <input type="radio" checked={batchFormat === f} onChange={() => setBatchFormat(f)} />
                  {f}
                </label>
              ))}
            </div>

            <button
              className="hermes-panel__btn hermes-panel__btn--primary"
              onClick={handleRunBatch}
              disabled={loading}
            >
              ▶ 运行批处理
            </button>

            {batchResults && (
              <div className="hermes-panel__results">
                <div className="hermes-panel__results-title">
                  结果（{batchResults.filter((r) => r.success).length}/{batchResults.length} 成功）
                </div>
                {batchResults.map((r) => (
                  <div
                    key={r.id}
                    className={`hermes-panel__result-item${r.success ? '' : ' hermes-panel__result-item--error'}`}
                  >
                    <span className="hermes-panel__result-id">{r.id}</span>
                    <span className="hermes-panel__result-text">
                      {r.success ? r.response.substring(0, 200) : r.error}
                    </span>
                    <span className="hermes-panel__result-duration">{r.duration}ms</span>
                  </div>
                ))}
              </div>
            )}

            {batchRawOutput && <pre className="hermes-panel__pre">{batchRawOutput}</pre>}
          </div>
        )}

        {activeTab === 'ide' && (
          <div className="hermes-panel__section">
            <label className="hermes-panel__label">会话 ID（可选，留空自动生成）</label>
            <input
              className="hermes-panel__input"
              value={ideSessionId}
              onChange={(e) => setIdeSessionId(e.target.value)}
              placeholder="自动生成"
            />

            <label className="hermes-panel__label">消息</label>
            <textarea
              className="hermes-panel__textarea"
              rows={4}
              value={ideMessage}
              onChange={(e) => setIdeMessage(e.target.value)}
              placeholder="输入消息..."
            />

            <button className="hermes-panel__btn hermes-panel__btn--primary" onClick={handleIdeChat} disabled={loading}>
              ▶ 发送
            </button>

            {ideResponse && (
              <div className="hermes-panel__response">
                <div className="hermes-panel__results-title">响应</div>
                <div className="hermes-panel__response-text">{ideResponse}</div>
              </div>
            )}

            <div className="hermes-panel__sessions">
              <div className="hermes-panel__results-title">
                活跃会话（{ideSessions.length}）
                <button className="hermes-panel__btn hermes-panel__btn--small" onClick={loadIdeSessions}>
                  刷新
                </button>
              </div>
              {ideSessions.length === 0 ? (
                <div className="hermes-panel__hint">暂无活跃会话</div>
              ) : (
                ideSessions.map((s) => (
                  <div key={s.sessionId} className="hermes-panel__session-item">
                    <span className="hermes-panel__session-id">{s.sessionId}</span>
                    <span className="hermes-panel__session-count">{s.messageCount} 条消息</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'trajectory' && (
          <div className="hermes-panel__section">
            {trajectoryStats && (
              <div className="hermes-panel__stats">
                <div className="hermes-panel__stat-card">
                  <span className="hermes-panel__stat-value">{trajectoryStats.total}</span>
                  <span className="hermes-panel__stat-label">总轨迹</span>
                </div>
                <div className="hermes-panel__stat-card">
                  <span className="hermes-panel__stat-value">{trajectoryStats.filtered}</span>
                  <span className="hermes-panel__stat-label">已过滤</span>
                </div>
                <div className="hermes-panel__stat-card">
                  <span className="hermes-panel__stat-value">{(trajectoryStats.avgQuality * 100).toFixed(1)}%</span>
                  <span className="hermes-panel__stat-label">平均质量</span>
                </div>
                <div className="hermes-panel__stat-card">
                  <span className="hermes-panel__stat-value">{trajectoryStats.avgSteps}</span>
                  <span className="hermes-panel__stat-label">平均步数</span>
                </div>
              </div>
            )}

            <label className="hermes-panel__label">导出格式</label>
            <div className="hermes-panel__btn-group">
              <button
                className="hermes-panel__btn"
                onClick={() => handleExportTrajectory('sharegpt')}
                disabled={loading}
              >
                ShareGPT
              </button>
              <button className="hermes-panel__btn" onClick={() => handleExportTrajectory('jsonl')} disabled={loading}>
                JSONL
              </button>
              <button
                className="hermes-panel__btn"
                onClick={() => handleExportTrajectory('openai_finetune')}
                disabled={loading}
              >
                OpenAI Fine-tune
              </button>
              <button className="hermes-panel__btn hermes-panel__btn--small" onClick={loadTrajectoryStats}>
                刷新统计
              </button>
            </div>

            {trajectoryExport && <pre className="hermes-panel__pre">{trajectoryExport}</pre>}
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="hermes-panel__section">
            <div className="hermes-panel__subgroup">
              <div className="hermes-panel__results-title">🎨 图像生成</div>
              <label className="hermes-panel__label">图像描述（英文效果最佳）</label>
              <input
                className="hermes-panel__input"
                value={imgPrompt}
                onChange={(e) => setImgPrompt(e.target.value)}
                placeholder="a cute cat sitting on a windowsill"
              />
              <label className="hermes-panel__label">尺寸</label>
              <select className="hermes-panel__select" value={imgSize} onChange={(e) => setImgSize(e.target.value)}>
                <option value="square_hd">square_hd</option>
                <option value="square">square</option>
                <option value="portrait_4_3">portrait_4_3</option>
                <option value="portrait_16_9">portrait_16_9</option>
                <option value="landscape_4_3">landscape_4_3</option>
                <option value="landscape_16_9">landscape_16_9</option>
              </select>
              <button
                className="hermes-panel__btn hermes-panel__btn--primary"
                onClick={handleGenerateImage}
                disabled={loading}
              >
                ▶ 生成图像
              </button>
              {imgResult && <pre className="hermes-panel__pre">{imgResult}</pre>}
            </div>

            <div className="hermes-panel__subgroup">
              <div className="hermes-panel__results-title">🔊 文本转语音</div>
              <label className="hermes-panel__label">文本内容</label>
              <textarea
                className="hermes-panel__textarea"
                rows={3}
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
                placeholder="输入要转为语音的文本..."
              />
              <label className="hermes-panel__label">音色</label>
              <select className="hermes-panel__select" value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
                <option value="default">default</option>
                <option value="female-gentle">female-gentle</option>
                <option value="female-professional">female-professional</option>
                <option value="male-deep">male-deep</option>
              </select>
              <button
                className="hermes-panel__btn hermes-panel__btn--primary"
                onClick={handleSpeakTts}
                disabled={loading}
              >
                ▶ 生成语音
              </button>
              {ttsResult && <pre className="hermes-panel__pre">{ttsResult}</pre>}
            </div>

            <div className="hermes-panel__subgroup">
              <div className="hermes-panel__results-title">🌐 网页抓取</div>
              <label className="hermes-panel__label">URL</label>
              <input
                className="hermes-panel__input"
                value={fetchUrl}
                onChange={(e) => setFetchUrl(e.target.value)}
                placeholder="https://example.com"
              />
              <button
                className="hermes-panel__btn hermes-panel__btn--primary"
                onClick={handleFetchWeb}
                disabled={loading}
              >
                ▶ 抓取网页
              </button>
              {fetchResult && <pre className="hermes-panel__pre">{fetchResult}</pre>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default HermesPanel;
