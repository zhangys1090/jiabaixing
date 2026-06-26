/**
 * CLIPanel - 命令终端面板
 * 提供终端风格的命令行交互界面
 * 支持命令: help, status, gateway, tools, security, memory, automation, clear
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import './CLIPanel.css';
import { apiService, getApiBaseUrl, getWsBaseUrl } from '../../api/apiService';

interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system';
  content: string;
  timestamp: number;
}

/** 命令处理结果 */
interface CommandResult {
  output: string;
  isError?: boolean;
}

/** 网关配置 */
interface GatewayConfig {
  apiBaseUrl: string;
  wsBaseUrl: string;
  timeout: number;
  retryCount: number;
}

const DEFAULT_GATEWAY: GatewayConfig = {
  apiBaseUrl: getApiBaseUrl(),
  wsBaseUrl: getWsBaseUrl(),
  timeout: 30000,
  retryCount: 3,
};

const WELCOME_LINES: TerminalLine[] = [
  { type: 'system', content: '╔══════════════════════════════════════╗', timestamp: 0 },
  { type: 'system', content: '║   家百星 · 命令终端 v1.0            ║', timestamp: 0 },
  { type: 'system', content: '╚══════════════════════════════════════╝', timestamp: 0 },
  { type: 'system', content: '输入 help 查看可用命令', timestamp: 0 },
];

const CLIPanel: React.FC = () => {
  const [lines, setLines] = useState<TerminalLine[]>(WELCOME_LINES);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [_historyIndex, setHistoryIndex] = useState(-1);
  const [gateway, setGateway] = useState<GatewayConfig>(DEFAULT_GATEWAY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 自动滚动到底部 */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  /** 点击面板聚焦输入框 */
  const handlePanelClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  /** 添加一行输出 */
  const addLine = useCallback((type: TerminalLine['type'], content: string) => {
    setLines((prev) => [...prev, { type, content, timestamp: Date.now() }]);
  }, []);

  /** 命令: help */
  const cmdHelp = useCallback((): CommandResult => ({
    output: [
      '可用命令:',
      '  help       - 显示帮助信息',
      '  status     - 查看系统状态',
      '  gateway    - 查看/设置网关配置',
      '  tools      - 列出可用工具',
      '  security   - 查看安全状态',
      '  memory     - 记忆系统操作',
      '  automation - 自动化任务管理',
      '  clear      - 清空终端',
      '',
      '网关子命令:',
      '  gateway              - 查看当前网关配置',
      '  gateway set <k> <v>  - 设置网关参数',
      '    可选键: api_url, ws_url, timeout, retry_count',
      '',
      '记忆子命令:',
      '  memory              - 查看记忆统计',
      '  memory search <关键词> - 搜索记忆',
      '  memory profile      - 查看用户画像',
      '',
      '自动化子命令:',
      '  automation          - 列出自动化任务',
      '  automation triggers - 列出主动触发器',
      '  automation toggle <id> - 切换任务启用/禁用',
      '  automation run <id> - 执行任务',
    ].join('\n'),
  }), []);

  /** 命令: status */
  const cmdStatus = useCallback(async (): Promise<CommandResult> => {
    try {
      const result = await apiService.getHealth();
      if (result.success && result.data) {
        const data = result.data as unknown as Record<string, unknown>;
        return {
          output: [
            '系统状态:',
            `  运行时间: ${data.uptime ?? '--'}`,
            `  LLM可用: ${data.llm ? '✅' : '❌'}`,
            `  API地址: ${gateway.apiBaseUrl}`,
            `  WS地址:  ${gateway.wsBaseUrl}`,
            `  超时:    ${gateway.timeout}ms`,
            `  重试:    ${gateway.retryCount}次`,
          ].join('\n'),
        };
      }
      return { output: '系统状态获取失败', isError: true };
    } catch (e) {
      return { output: `请求失败: ${(e as Error).message}`, isError: true };
    }
  }, [gateway]);

  /** 命令: gateway */
  const cmdGateway = useCallback((args: string[]): CommandResult => {
    if (args.length === 0) {
      return {
        output: [
          '当前网关配置:',
          `  api_url:     ${gateway.apiBaseUrl}`,
          `  ws_url:      ${gateway.wsBaseUrl}`,
          `  timeout:     ${gateway.timeout}ms`,
          `  retry_count: ${gateway.retryCount}`,
        ].join('\n'),
      };
    }

    if (args[0] === 'set' && args.length >= 3) {
      const key = args[1];
      const value = args.slice(2).join(' ');
      switch (key) {
        case 'api_url':
          setGateway((prev) => ({ ...prev, apiBaseUrl: value }));
          apiService.setBaseUrl(value);
          return { output: `API网关已设置为: ${value}` };
        case 'ws_url':
          setGateway((prev) => ({ ...prev, wsBaseUrl: value }));
          return { output: `WebSocket网关已设置为: ${value}` };
        case 'timeout': {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 1000) {
            return { output: '超时值必须 >= 1000ms', isError: true };
          }
          setGateway((prev) => ({ ...prev, timeout: num }));
          return { output: `连接超时已设置为: ${num}ms` };
        }
        case 'retry_count': {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 0 || num > 10) {
            return { output: '重试次数范围: 0-10', isError: true };
          }
          setGateway((prev) => ({ ...prev, retryCount: num }));
          return { output: `重试次数已设置为: ${num}` };
        }
        default:
          return { output: `未知配置项: ${key}。可选: api_url, ws_url, timeout, retry_count`, isError: true };
      }
    }

    return { output: '用法: gateway [set <key> <value>]', isError: true };
  }, [gateway]);

  /** 命令: tools */
  const cmdTools = useCallback(async (): Promise<CommandResult> => {
    try {
      const result = await apiService.listSkills();
      if (result.success && result.data) {
        const data = result.data as unknown as { skills?: Array<{ name: string; description?: string }> };
        const skills = data.skills || [];
        if (skills.length === 0) {
          return { output: '暂无已注册工具' };
        }
        const lines = ['已注册工具:', ...skills.map((s) => `  ${s.name}${s.description ? ` - ${s.description}` : ''}`)];
        return { output: lines.join('\n') };
      }
      return { output: '工具列表获取失败', isError: true };
    } catch (e) {
      return { output: `请求失败: ${(e as Error).message}`, isError: true };
    }
  }, []);

  /** 命令: security */
  const cmdSecurity = useCallback(async (): Promise<CommandResult> => {
    try {
      const result = await apiService.getSecurityReport();
      if (result.success && result.data) {
        const data = result.data as unknown as Record<string, unknown>;
        return {
          output: [
            '安全状态:',
            `  总体评分: ${data.overallScore ?? '--'}`,
            `  事件总数: ${data.totalEvents ?? '--'}`,
            `  最后检查: ${data.lastCheck ?? '--'}`,
          ].join('\n'),
        };
      }
      return { output: '安全报告获取失败', isError: true };
    } catch (e) {
      return { output: `请求失败: ${(e as Error).message}`, isError: true };
    }
  }, []);

  /** 命令: memory */
  const cmdMemory = useCallback(async (args: string[]): Promise<CommandResult> => {
    const subCommand = args[0] || 'stats';
    try {
      switch (subCommand) {
        case 'stats': {
          const result = await apiService.getMemoryStats();
          if (result.success && result.data) {
            const d = result.data;
            const typeLines = Object.entries(d.typeDistribution as Record<string, number>)
              .map(([type, count]) => `    ${type}: ${count}`)
              .join('\n');
            return {
              output: [
                '记忆统计:',
                `  总记录: ${d.totalRecords}`,
                `  数据库大小: ${d.databaseSizeMB.toFixed(1)}MB`,
                `  类型分布:`,
                typeLines || '    (无)',
              ].join('\n'),
            };
          }
          return { output: '记忆统计获取失败', isError: true };
        }
        case 'search': {
          const query = args.slice(1).join(' ');
          if (!query) return { output: '用法: memory search <关键词>', isError: true };
          const result = await apiService.searchMemory(query);
          if (result.success && result.data) {
            const d = result.data;
            if (d.results.length === 0) {
              return { output: `未找到与 "${query}" 相关的记忆` };
            }
            const resultLines = d.results
              .slice(0, 10)
              .map((r, i) => `  ${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${r.content.substring(0, 80)}`)
              .join('\n');
            return {
              output: [
                `搜索 "${query}" (${d.total} 条结果):`,
                resultLines,
              ].join('\n'),
            };
          }
          return { output: '记忆搜索失败', isError: true };
        }
        case 'profile': {
          const result = await apiService.getMemoryProfile();
          if (result.success && result.data) {
            const d = result.data;
            const sections = [
              { label: '基本信息', data: d.basicInfo },
              { label: '开发习惯', data: d.developmentHabits },
              { label: '生活偏好', data: d.lifePreferences },
              { label: '情绪模式', data: d.emotionalPatterns },
              { label: '任务偏好', data: d.taskPreferences },
            ];
            const sectionLines = sections
              .filter((s) => Object.keys(s.data).length > 0)
              .map((s) => {
                const entries = Object.entries(s.data)
                  .map(([k, v]) => `    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                  .join('\n');
                return `  ${s.label}:\n${entries}`;
              })
              .join('\n\n');
            return {
              output: sectionLines ? `用户画像:\n${sectionLines}` : '用户画像数据为空',
            };
          }
          return { output: '用户画像获取失败', isError: true };
        }
        default:
          return { output: `未知 memory 子命令: ${subCommand}\n用法: memory [stats|search <关键词>|profile]`, isError: true };
      }
    } catch (e) {
      return { output: `请求失败: ${(e as Error).message}`, isError: true };
    }
  }, []);

  /** 命令: automation */
  const cmdAutomation = useCallback(async (args: string[]): Promise<CommandResult> => {
    const subCommand = args[0] || 'tasks';
    try {
      switch (subCommand) {
        case 'tasks': {
          const result = await apiService.getAutomationTasks();
          if (result.success && result.data) {
            const tasks = result.data.tasks || [];
            if (tasks.length === 0) return { output: '暂无自动化任务' };
            const taskLines = tasks
              .map((t) => `  ${t.enabled ? '✅' : '⬜'} ${t.id} | ${t.name} | ⏰${t.schedule} | 执行:${t.executionCount} 成功:${t.successCount}`)
              .join('\n');
            return { output: `自动化任务 (${tasks.length}):\n${taskLines}` };
          }
          return { output: '任务列表获取失败', isError: true };
        }
        case 'triggers': {
          const result = await apiService.getAutomationTriggers();
          if (result.success && result.data) {
            const triggers = result.data.triggers || [];
            if (triggers.length === 0) return { output: '暂无主动触发器' };
            const triggerLines = triggers
              .map((t, i) => `  ${i + 1}. [${t.type}] ${t.reason} (优先级:${t.priority})`)
              .join('\n');
            return { output: `主动触发器 (${triggers.length}):\n${triggerLines}` };
          }
          return { output: '触发器列表获取失败', isError: true };
        }
        case 'toggle': {
          const taskId = args[1];
          if (!taskId) return { output: '用法: automation toggle <taskId>', isError: true };
          // 先获取当前任务状态
          const listResult = await apiService.getAutomationTasks();
          if (listResult.success && listResult.data) {
            const task = listResult.data.tasks?.find((t) => t.id === taskId);
            if (!task) return { output: `任务不存在: ${taskId}`, isError: true };
            const newEnabled = !task.enabled;
            const result = await apiService.toggleAutomationTask(taskId, newEnabled);
            if (result.success) {
              return { output: `任务 ${taskId} 已${newEnabled ? '启用' : '禁用'}` };
            }
            return { output: `切换任务状态失败`, isError: true };
          }
          return { output: '获取任务状态失败', isError: true };
        }
        case 'run': {
          const taskId = args[1];
          if (!taskId) return { output: '用法: automation run <taskId>', isError: true };
          const result = await apiService.executeAutomationTask(taskId);
          if (result.success) {
            return { output: `任务 ${taskId} 已触发执行` };
          }
          return { output: `执行任务失败`, isError: true };
        }
        default:
          return { output: `未知 automation 子命令: ${subCommand}\n用法: automation [tasks|triggers|toggle <id>|run <id>]`, isError: true };
      }
    } catch (e) {
      return { output: `请求失败: ${(e as Error).message}`, isError: true };
    }
  }, []);

  /** 执行命令 */
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    addLine('input', `> ${trimmed}`);

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (command === 'clear') {
      setLines([]);
      return;
    }

    let result: CommandResult;
    switch (command) {
      case 'help':
        result = cmdHelp();
        break;
      case 'status':
        result = await cmdStatus();
        break;
      case 'gateway':
        result = cmdGateway(args);
        break;
      case 'tools':
        result = await cmdTools();
        break;
      case 'security':
        result = await cmdSecurity();
        break;
      case 'memory':
        result = await cmdMemory(args);
        break;
      case 'automation':
        result = await cmdAutomation(args);
        break;
      default:
        result = { output: `未知命令: ${command}。输入 help 查看可用命令。`, isError: true };
    }

    addLine(result.isError ? 'error' : 'output', result.output);
  }, [addLine, cmdHelp, cmdStatus, cmdGateway, cmdTools, cmdSecurity, cmdMemory, cmdAutomation]);

  /** 提交输入 */
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const value = input;
    setHistory((prev) => [...prev, value]);
    setHistoryIndex(-1);
    setInput('');
    executeCommand(value);
  }, [input, executeCommand]);

  /** 上下箭头历史导航 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistoryIndex((prev) => {
        const newIndex = Math.min(prev + 1, history.length - 1);
        if (newIndex >= 0) setInput(history[history.length - 1 - newIndex]);
        return newIndex;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistoryIndex((prev) => {
        const newIndex = Math.max(prev - 1, -1);
        if (newIndex >= 0) {
          setInput(history[history.length - 1 - newIndex]);
        } else {
          setInput('');
        }
        return newIndex;
      });
    }
  }, [history]);

  return (
    <div className="cli-panel" onClick={handlePanelClick}>
      <div className="cli-output" ref={scrollRef}>
        {lines.map((line, i) => (
          <div key={i} className={`cli-line cli-line--${line.type}`}>
            {line.content}
          </div>
        ))}
      </div>
      <form className="cli-input-bar" onSubmit={handleSubmit}>
        <span className="cli-prompt">❯</span>
        <input
          ref={inputRef}
          className="cli-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入命令..."
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </div>
  );
};

export default CLIPanel;
