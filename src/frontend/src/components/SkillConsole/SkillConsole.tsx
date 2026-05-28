/**
 * SkillConsole v3 - 技能控制台
 * 暗黑极客终端风格，支持22个技能的即插即用测试
 * 连接真实后端API，支持技能注册/执行/反馈闭环
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { connectionManager } from '../../hooks/useWebSocket';
import { apiService } from '../../api/apiService';
import './SkillConsole.css';

interface SkillMeta {
  name: string;
  description: string;
  category: string;
  version: string;
  tags: string[];
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    default?: unknown;
  }>;
}

interface SkillExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'warn' | 'command';
  message: string;
  detail?: unknown;
}

const CATEGORY_COLORS: Record<string, string> = {
  meta: '#c9a86c',
  automation: '#7a9eb8',
  research: '#7ca982',
  development: '#d4a574',
  schedule: '#b8a0d4',
  file: '#a0c4d4',
  search: '#8cb8a0',
  command: '#d4a0a0',
  browser: '#a0b8d4',
};

const CATEGORY_ICONS: Record<string, string> = {
  meta: '⚙️',
  automation: '🤖',
  research: '🔍',
  development: '💻',
  schedule: '📅',
  file: '📁',
  search: '🔎',
  command: '⌨️',
  browser: '🌐',
};

const SkillConsole: React.FC = () => {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [filteredSkills, setFilteredSkills] = useState<SkillMeta[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillMeta | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastResult, setLastResult] = useState<SkillExecuteResult | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [executionDuration, setExecutionDuration] = useState<number | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const wsListenerRef = useRef<(() => void) | null>(null);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    fetchSkills();
    setupWebSocketListener();

    const healthCheck = setInterval(async () => {
      try {
        const result = await apiService.getHealth();
        setConnectionStatus(result.success ? 'connected' : 'disconnected');
      } catch {
        setConnectionStatus('disconnected');
      }
    }, 10000);

    return () => {
      clearInterval(healthCheck);
      if (wsListenerRef.current) {
        wsListenerRef.current();
      }
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    let result = skills;
    if (activeCategory !== 'all') {
      result = result.filter((s) => s.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    setFilteredSkills(result);
  }, [skills, searchQuery, activeCategory]);

  const addLog = useCallback((type: LogEntry['type'], message: string, detail?: unknown) => {
    setLogs((prev) => [
      ...prev,
      {
        id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        type,
        message,
        detail,
      },
    ]);
  }, []);

  const setupWebSocketListener = () => {
    const handler = (data: unknown) => {
      const result = data as SkillExecuteResult;
      setLastResult(result);
      setIsExecuting(false);
      if (result.success) {
        addLog('success', 'WebSocket: 执行成功', result.output);
      } else {
        addLog('error', `WebSocket: 执行失败 - ${result.error || '未知错误'}`);
      }
    };
    const unsubscribe = connectionManager.on('skill_result', handler);
    wsListenerRef.current = unsubscribe;
  };

  const fetchSkills = async () => {
    addLog('info', '正在从后端获取技能列表...');
    try {
      const result = await apiService.listSkills();
      if (!result.success || !result.data) throw new Error(result.error || '获取失败');
      const data = result.data as unknown as {
        skills: SkillMeta[];
        count: number;
      };
      setSkills(data.skills || []);
      setConnectionStatus('connected');
      addLog('success', `已加载 ${data.count || data.skills?.length || 0} 个技能（来自后端API）`);
    } catch (error) {
      addLog('warn', `后端API不可用: ${(error as Error).message}，使用本地列表`);
      setConnectionStatus('disconnected');
      const fallbackSkills: SkillMeta[] = [
        {
          name: 'file',
          description: '本地文件读写',
          category: 'file',
          version: '1.0.0',
          tags: ['file', 'io'],
          parameters: [
            {
              name: 'action',
              type: 'string',
              required: true,
              description: 'read|write|list',
            },
            {
              name: 'path',
              type: 'string',
              required: true,
              description: '文件路径',
            },
          ],
        },
        {
          name: 'search',
          description: '本地文本/代码搜索',
          category: 'search',
          version: '1.0.0',
          tags: ['search'],
          parameters: [
            {
              name: 'query',
              type: 'string',
              required: true,
              description: '搜索关键词',
            },
          ],
        },
        {
          name: 'schedule',
          description: '日程/提醒/任务管理',
          category: 'schedule',
          version: '1.0.0',
          tags: ['schedule', 'task'],
          parameters: [
            {
              name: 'action',
              type: 'string',
              required: true,
              description: 'create|query|remind',
            },
          ],
        },
        {
          name: 'command',
          description: '安全命令执行',
          category: 'command',
          version: '1.0.0',
          tags: ['command', 'terminal'],
          parameters: [
            {
              name: 'command',
              type: 'string',
              required: true,
              description: '要执行的命令',
            },
          ],
        },
        {
          name: 'ide',
          description: 'IDE集成: 文件操作/命令执行/代码编辑',
          category: 'development',
          version: '1.0.0',
          tags: ['ide', 'vscode', 'editor'],
          parameters: [
            {
              name: 'action',
              type: 'string',
              required: true,
              description: 'openFile|readFile|writeFile|runCommand|getDiagnostics|applyEdit|status',
            },
            {
              name: 'uri',
              type: 'string',
              required: false,
              description: '文件URI',
            },
          ],
        },
        {
          name: 'web-search',
          description: '实时联网搜索',
          category: 'research',
          version: '1.0.0',
          tags: ['web-search'],
          parameters: [
            {
              name: 'query',
              type: 'string',
              required: true,
              description: '搜索关键词',
            },
          ],
        },
        {
          name: 'playwright',
          description: '网页自动化',
          category: 'browser',
          version: '1.0.0',
          tags: ['browser', 'automation'],
          parameters: [
            {
              name: 'action',
              type: 'string',
              required: true,
              description: 'navigate|screenshot|click',
            },
            {
              name: 'url',
              type: 'string',
              required: false,
              description: '目标URL',
            },
          ],
        },
        {
          name: 'code-analysis',
          description: '代码分析',
          category: 'development',
          version: '1.0.0',
          tags: ['code', 'analysis'],
          parameters: [
            {
              name: 'filePath',
              type: 'string',
              required: true,
              description: '代码文件路径',
            },
          ],
        },
      ];
      setSkills(fallbackSkills);
    }
  };

  const handleSkillSelect = (skill: SkillMeta) => {
    setSelectedSkill(skill);
    const defaults: Record<string, unknown> = {};
    skill.parameters.forEach((p) => {
      if (p.default !== undefined) defaults[p.name] = p.default;
    });
    setParamValues(defaults);
    setLastResult(null);
    setExecutionDuration(null);
    addLog('info', `已选择技能: ${skill.name} (${skill.category})`);
  };

  const handleExecute = async () => {
    if (!selectedSkill) return;

    setIsExecuting(true);
    setLastResult(null);
    setExecutionDuration(null);
    addLog('command', `▶ 执行: ${selectedSkill.name}`, paramValues);

    const startTime = Date.now();

    try {
      const result = await apiService.executeSkill(selectedSkill.name, paramValues);

      const duration = Date.now() - startTime;
      setExecutionDuration(duration);

      if (!result.success) {
        throw new Error(result.error || '执行失败');
      }

      const skillResult = result.data as SkillExecuteResult;
      setLastResult(skillResult);

      if (skillResult.success) {
        addLog('success', `✅ ${selectedSkill.name} 执行成功 (${duration}ms)`, skillResult.output);
      } else {
        addLog('error', `❌ ${selectedSkill.name} 执行失败: ${skillResult.error || '未知错误'}`);
      }

      try {
        connectionManager.send({
          type: 'skill_executed',
          payload: {
            skillName: selectedSkill.name,
            success: skillResult.success,
            duration,
          },
        });
      } catch {
        // WebSocket 发送失败不影响主流程
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      setExecutionDuration(duration);
      const errorMsg = (error as Error).message;
      addLog('error', `❌ 执行异常: ${errorMsg}`);
      setLastResult({ success: false, error: errorMsg });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleParamChange = (name: string, value: unknown) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  };

  const clearLogs = () => {
    setLogs([]);
    setLastResult(null);
    setExecutionDuration(null);
  };

  const formatOutput = (data: unknown): string => {
    if (data === null || data === undefined) return '(空)';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  const categories = ['all', ...Array.from(new Set(skills.map((s) => s.category)))];

  if (!isVisible) {
    return (
      <button className="skill-console-trigger" onClick={() => setIsVisible(true)} title="打开技能控制台">
        <span className="trigger-icon">⚡</span>
        <span className="trigger-label">技能控制台</span>
        <span className="trigger-badge">{skills.length}</span>
        <span className={`trigger-status trigger-status-${connectionStatus}`} />
      </button>
    );
  }

  return (
    <div className="skill-console-overlay" onClick={() => setIsVisible(false)}>
      <div className="skill-console-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="sc-header">
          <div className="sc-header-left">
            <span className="sc-logo">⚡</span>
            <h2 className="sc-title">SKILL CONSOLE</h2>
            <span className="sc-version">v3.0</span>
            <span className={`sc-conn-status sc-conn-${connectionStatus}`}>
              {connectionStatus === 'connected' ? '●' : connectionStatus === 'connecting' ? '◐' : '○'}
              {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中' : '离线'}
            </span>
          </div>
          <div className="sc-header-right">
            <span className="sc-skill-count">{skills.length} SKILLS</span>
            <button className="sc-refresh-btn" onClick={fetchSkills} title="刷新技能列表">
              🔄
            </button>
            <button className="sc-close-btn" onClick={() => setIsVisible(false)}>
              ✕
            </button>
          </div>
        </div>

        <div className="sc-body">
          {/* 左侧：技能列表 */}
          <div className="sc-sidebar">
            <div className="sc-search-box">
              <span className="sc-search-icon">🔍</span>
              <input
                type="text"
                className="sc-search-input"
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="sc-search-clear" onClick={() => setSearchQuery('')}>
                  ✕
                </button>
              )}
            </div>

            <div className="sc-category-tabs">
              {categories.map((cat) => (
                <button
                  key={cat}
                  className={`sc-category-tab ${activeCategory === cat ? 'active' : ''}`}
                  onClick={() => setActiveCategory(cat)}
                  style={
                    {
                      '--cat-color': cat === 'all' ? '#c9a86c' : CATEGORY_COLORS[cat] || '#8a8580',
                    } as React.CSSProperties
                  }
                >
                  {cat === 'all' ? '📋' : CATEGORY_ICONS[cat] || '🔧'}
                  <span>{cat === 'all' ? '全部' : cat}</span>
                  <span className="sc-category-count">
                    {cat === 'all' ? skills.length : skills.filter((s) => s.category === cat).length}
                  </span>
                </button>
              ))}
            </div>

            <div className="sc-skill-list">
              {filteredSkills.map((skill) => (
                <button
                  key={skill.name}
                  className={`sc-skill-item ${selectedSkill?.name === skill.name ? 'active' : ''}`}
                  onClick={() => handleSkillSelect(skill)}
                >
                  <div className="sc-skill-item-header">
                    <span
                      className="sc-skill-dot"
                      style={{
                        background: CATEGORY_COLORS[skill.category] || '#8a8580',
                      }}
                    />
                    <span className="sc-skill-name">{skill.name}</span>
                    <span className="sc-skill-version">v{skill.version}</span>
                  </div>
                  <p className="sc-skill-desc">{skill.description}</p>
                  <div className="sc-skill-tags">
                    {skill.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="sc-skill-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
              {filteredSkills.length === 0 && <div className="sc-empty">未找到匹配的技能</div>}
            </div>
          </div>

          {/* 中间：参数配置 */}
          <div className="sc-config-panel">
            {selectedSkill ? (
              <>
                <div className="sc-config-header">
                  <h3 className="sc-config-title">
                    <span
                      className="sc-config-category"
                      style={{
                        color: CATEGORY_COLORS[selectedSkill.category] || '#c9a86c',
                      }}
                    >
                      {CATEGORY_ICONS[selectedSkill.category] || '🔧'} {selectedSkill.category}
                    </span>
                    {selectedSkill.name}
                  </h3>
                  <p className="sc-config-desc">{selectedSkill.description}</p>
                </div>

                <div className="sc-params-form">
                  <h4 className="sc-params-title">参数配置</h4>
                  {selectedSkill.parameters.map((param) => (
                    <div key={param.name} className="sc-param-row">
                      <label className="sc-param-label">
                        {param.name}
                        {param.required && <span className="sc-param-required">*</span>}
                        <span className="sc-param-type">{param.type}</span>
                      </label>
                      <input
                        type="text"
                        className="sc-param-input"
                        placeholder={param.description}
                        value={(paramValues[param.name] as string) || ''}
                        onChange={(e) => handleParamChange(param.name, e.target.value)}
                      />
                      <span className="sc-param-hint">{param.description}</span>
                    </div>
                  ))}
                  {selectedSkill.parameters.length === 0 && <p className="sc-no-params">此技能无需参数</p>}
                </div>

                <button
                  className={`sc-execute-btn ${isExecuting ? 'executing' : ''}`}
                  onClick={handleExecute}
                  disabled={isExecuting}
                >
                  {isExecuting ? (
                    <>
                      <span className="sc-spinner" />
                      执行中...
                    </>
                  ) : (
                    <>
                      <span>▶</span> 执行技能
                    </>
                  )}
                </button>

                {executionDuration !== null && (
                  <div className="sc-execution-time">⏱ 执行耗时: {executionDuration}ms</div>
                )}
              </>
            ) : (
              <div className="sc-no-selection">
                <span className="sc-no-selection-icon">👈</span>
                <p>从左侧选择一个技能进行测试</p>
              </div>
            )}
          </div>

          {/* 右侧：日志与结果 */}
          <div className="sc-output-panel">
            <div className="sc-output-header">
              <span className="sc-output-title">📟 执行日志</span>
              <button className="sc-clear-btn" onClick={clearLogs}>
                清空
              </button>
            </div>

            <div className="sc-logs">
              {logs.map((log) => (
                <div key={log.id} className={`sc-log-entry sc-log-${log.type}`}>
                  <span className="sc-log-time">{log.timestamp}</span>
                  <span className={`sc-log-badge sc-log-badge-${log.type}`}>{log.type.toUpperCase()}</span>
                  <span className="sc-log-message">{log.message}</span>
                  {log.detail !== undefined && (
                    <details className="sc-log-detail">
                      <summary>详情</summary>
                      <pre>{formatOutput(log.detail)}</pre>
                    </details>
                  )}
                </div>
              ))}
              {logs.length === 0 && <div className="sc-logs-empty">等待执行...</div>}
              <div ref={logsEndRef} />
            </div>

            {lastResult && (
              <div className={`sc-result ${lastResult.success ? 'success' : 'error'}`}>
                <div className="sc-result-header">
                  <span>{lastResult.success ? '✅ 执行成功' : '❌ 执行失败'}</span>
                  {executionDuration !== null && <span className="sc-result-duration">{executionDuration}ms</span>}
                </div>
                <pre className="sc-result-body">
                  {formatOutput(lastResult.success ? lastResult.output : lastResult.error)}
                </pre>
                {lastResult.metadata && (
                  <details className="sc-result-meta">
                    <summary>元数据</summary>
                    <pre>{formatOutput(lastResult.metadata)}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SkillConsole;
