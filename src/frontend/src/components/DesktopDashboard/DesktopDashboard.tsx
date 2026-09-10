import type {
  HealthResponse,
  MemorySearchResponse,
  MemoryStatsResponse,
  SystemResourcesResponse,
} from '@shared/contracts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiService } from '../../api/apiService';
import type { View } from '../../App';
import { useTheme } from '../../contexts/ThemeContext';
import { useToast } from '../../contexts/ToastContext';
import { useUserPreferences } from '../../hooks/useUserPreferences';
import { useAgentStore } from '../../stores/useAgentStore';
import { useBudgetStore } from '../../stores/useBudgetStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import './DesktopDashboard.css';
import { FEATURE_NODES, type FeatureNode } from './FeatureNodeGrid';

interface Message {
  id: number;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface ShortcutAction {
  id: string;
  icon: string;
  label: string;
  shortcut: string;
  action: () => void;
  view?: View;
}

interface DesktopDashboardProps {
  onNavigate?: (view: View) => void;
}

const STORAGE_KEY_MESSAGES = 'jiabaixing-dashboard-messages';
const MAX_STORED_MESSAGES = 100;

function loadStoredMessages(): Message[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MESSAGES);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map((m: Message) => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return null;
  }
}

function saveMessages(messages: Message[]) {
  try {
    const toStore = messages.slice(-MAX_STORED_MESSAGES);
    localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(toStore));
  } catch {
    /* ignore */
  }
}

const WELCOME_MESSAGES: Message[] = [
  {
    id: 1,
    type: 'system',
    content: '欢迎使用家百星智能助手系统 V5.0',
    timestamp: new Date(),
  },
  {
    id: 2,
    type: 'assistant',
    content: `我是您的AI助手，基于 Harness Agent Framework 构建。

**核心能力：**
- 🎯 **目标达成** — 自主规划、执行、验证，完成复杂任务链
- 💬 **智能对话** — 自然语言交互与深度问答
- 🔧 **工具执行** — 82+ 工具，自动选择最优路径
- 🧠 **记忆系统** — 短期+长期记忆，跨会话知识积累
- ⚡ **批量自动化** — 并行任务处理与工作流编排

**Agent 印记：**
每轮执行留下能力印记，追踪目标达成效率

**快捷命令：**
- /help — 查看帮助    /goal — 目标达成追踪
- /status — 系统状态   /clear — 清空对话
- /memory-search <关键词> — 搜索记忆

请告诉我您需要什么帮助？`,
    timestamp: new Date(),
  },
];

export const DesktopDashboard: React.FC<DesktopDashboardProps> = ({ onNavigate }) => {
  const { theme } = useTheme();
  const toast = useToast();
  const { preferences, setPreference, addRecentCommand } = useUserPreferences();
  const executionUpdates = useAgentStore((s) => s.executionUpdates);
  const toolTraces = useAgentStore((s) => s.toolTraces);

  const tokenUsed = useBudgetStore((s) => s.tokenUsed);
  const costUsed = useBudgetStore((s) => s.costUsed);
  const fetchBudgetStatus = useBudgetStore((s) => s.fetchBudgetStatus);

  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<Message[]>(() => {
    const stored = loadStoredMessages();
    return stored || WELCOME_MESSAGES;
  });
  const [isTyping, setIsTyping] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [memoryStats, setMemoryStats] = useState<MemoryStatsResponse | null>(null);
  const [systemResources, setSystemResources] = useState<SystemResourcesResponse | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthResponse | null>(null);
  const [skillList, setSkillList] = useState<{ name: string; description: string; category: string }[]>([]);
  const [dashboardDataLoaded, setDashboardDataLoaded] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const adjustTextareaHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const newHeight = Math.min(Math.max(el.scrollHeight, 40), 120);
    el.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, adjustTextareaHeight]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--hermes-font-size', `${preferences.fontSize}px`);
  }, [preferences.fontSize]);

  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(messages);
    }
  }, [messages]);

  const loadMemoryStats = useCallback(async () => {
    try {
      const result = await apiService.getMemoryStats();
      if (result.success && result.data) {
        setMemoryStats(result.data);
      }
    } catch {
      /* 静默失败，记忆服务非必须 */
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    try {
      const [memResult, resResult, healthResult, skillResult] = await Promise.allSettled([
        apiService.getMemoryStats(),
        apiService.getSystemResources(),
        apiService.getHealth(),
        apiService.listSkills(),
      ]);
      if (memResult.status === 'fulfilled' && memResult.value.success && memResult.value.data) {
        setMemoryStats(memResult.value.data);
      }
      if (resResult.status === 'fulfilled' && resResult.value.success && resResult.value.data) {
        setSystemResources(resResult.value.data);
      }
      if (healthResult.status === 'fulfilled' && healthResult.value.success && healthResult.value.data) {
        setHealthStatus(healthResult.value.data);
      }
      if (skillResult.status === 'fulfilled' && skillResult.value.success && skillResult.value.data) {
        const skills = skillResult.value.data as unknown as {
          skills?: Array<{ name: string; description: string; category: string }>;
        };
        setSkillList(skills.skills ?? []);
      }
    } catch {
      /* 静默失败 */
    } finally {
      setDashboardDataLoaded(true);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = messagesEndRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const navigateTo = useCallback(
    (view: View) => {
      if (onNavigate) {
        onNavigate(view);
        toast.showInfo(`已切换到${view}面板`);
      }
    },
    [onNavigate, toast]
  );

  const handleClearChat = useCallback(() => {
    setMessages([
      {
        id: Date.now(),
        type: 'system',
        content: '🗑️ 对话已清空',
        timestamp: new Date(),
      },
    ]);
    localStorage.removeItem(STORAGE_KEY_MESSAGES);
    toast.showSuccess('对话已清空');
  }, [toast]);

  const handleBatchProcess = useCallback(() => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        type: 'system',
        content: '⚡ 批量处理功能请通过 /goal 命令查看 Agent 能力',
        timestamp: new Date(),
      },
    ]);
  }, []);

  const handleAutomation = useCallback(() => {
    navigateTo('automation' as any);
  }, [navigateTo]);

  const handleVibeCoding = useCallback(() => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        type: 'system',
        content: '✨ Vibe 编码功能请通过 /goal 命令查看 Agent 能力',
        timestamp: new Date(),
      },
    ]);
  }, []);

  const handleMemory = useCallback(async () => {
    const msg: Message = {
      id: Date.now(),
      type: 'system',
      content: '🧠 正在查询记忆库...',
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, msg]);

    try {
      const result = await apiService.getMemoryStats();
      if (result.success && result.data) {
        const stats = result.data as MemoryStatsResponse;
        const response: Message = {
          id: Date.now() + 1,
          type: 'assistant',
          content: `**🧠 记忆库状态**

- 总记录数: ${stats.totalRecords ?? 'N/A'}
- 数据库大小: ${stats.databaseSizeMB ?? 'N/A'} MB
- 类型分布: ${
            stats.typeDistribution
              ? Object.entries(stats.typeDistribution)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')
              : 'N/A'
          }
- 最近更新: ${stats.timestamp ?? 'N/A'}

输入 /memory-search <关键词> 搜索记忆，或点击侧栏"记忆"面板进行管理。`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, response]);
      } else {
        const fallback: Message = {
          id: Date.now() + 1,
          type: 'assistant',
          content: '**🧠 记忆管理**\n\n记忆库暂未连接，请确保后端服务已启动。\n\n您也可以点击侧栏"记忆"面板进行管理。',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, fallback]);
      }
    } catch {
      const fallback: Message = {
        id: Date.now() + 1,
        type: 'assistant',
        content: '**🧠 记忆管理**\n\n记忆库暂未连接，请确保后端服务已启动。\n\n您也可以点击侧栏"记忆"面板进行管理。',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, fallback]);
    }
  }, []);

  const handleMonitor = useCallback(async () => {
    const msg: Message = {
      id: Date.now(),
      type: 'system',
      content: '📊 正在获取系统状态...',
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, msg]);

    try {
      const [healthResult, resourcesResult] = await Promise.all([
        apiService.getHealth(),
        apiService.getSystemResources(),
      ]);

      let content = '**📊 系统监控报告**\n\n';

      if (healthResult.success && healthResult.data) {
        const health = healthResult.data as HealthResponse;
        content += `**健康状态**: ${health.status ?? 'unknown'}\n`;
        content += `**版本**: ${health.model ?? 'N/A'}\n`;
        content += `**运行时间**: ${health.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : 'N/A'}\n\n`;
      }

      if (resourcesResult.success && resourcesResult.data) {
        const res = resourcesResult.data as SystemResourcesResponse;
        content += `**内存使用率**: ${res.memory?.usagePercent ?? 'N/A'}%\n`;
        content += `**堆内存**: ${res.memory?.heapUsed ?? 'N/A'} / ${res.memory?.heapTotal ?? 'N/A'} MB\n`;
        content += `**CPU 负载**: ${res.cpu?.loadAverage ? res.cpu.loadAverage.map((v) => v.toFixed(2)).join(', ') : 'N/A'}\n`;
        content += `**磁盘使用**: ${res.disk?.used ?? 'N/A'} / ${res.disk?.total ?? 'N/A'} GB\n`;
      } else {
        content += '⚠️ 系统资源数据暂不可用，请确保后端服务已启动。';
      }

      content += '\n\n点击侧栏"监控"面板查看更多详情。';

      const response: Message = {
        id: Date.now() + 1,
        type: 'assistant',
        content,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, response]);
    } catch {
      const fallback: Message = {
        id: Date.now() + 1,
        type: 'assistant',
        content: '**📊 系统监控**\n\n无法获取系统状态，请确保后端服务已启动。\n\n您也可以点击侧栏"监控"面板查看详情。',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, fallback]);
    }
  }, []);

  useEffect(() => {
    fetchBudgetStatus();
    loadDashboardData();
    const interval = setInterval(() => {
      fetchBudgetStatus();
      loadDashboardData();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchBudgetStatus, loadDashboardData]);

  const shortcuts: ShortcutAction[] = useMemo(
    () => [
      { id: 'new-chat', icon: '💬', label: '新建对话', shortcut: 'Ctrl+N', action: handleClearChat },
      { id: 'batch', icon: '⚡', label: '批量处理', shortcut: 'Ctrl+B', action: handleBatchProcess },
      { id: 'automation', icon: '🤖', label: '自动化', shortcut: 'Ctrl+T', action: handleAutomation },
      { id: 'code', icon: '✨', label: 'Vibe编码', shortcut: 'Ctrl+G', action: handleVibeCoding },
      { id: 'memory', icon: '🧠', label: '记忆管理', shortcut: 'Ctrl+M', action: handleMemory },
      {
        id: 'goal',
        icon: '🎯',
        label: '目标追踪',
        shortcut: 'Ctrl+P',
        action: () => {
          const e = inputRef.current;
          if (e) {
            e.value = '/goal';
            setInputValue('/goal');
          }
        },
      },
      { id: 'settings', icon: '⚙️', label: '偏好设置', shortcut: 'Ctrl+,', action: () => setShowSettings(true) },
    ],
    [handleClearChat, handleBatchProcess, handleAutomation, handleVibeCoding, handleMemory]
  );

  const handleSend = useCallback(
    async (explicitInput?: string) => {
      const rawInput = explicitInput ?? inputValue;
      if (!rawInput.trim()) return;

      if (rawInput.startsWith('/')) {
        addRecentCommand(rawInput.split(' ')[0]);
      }

      const userMessage: Message = {
        id: Date.now(),
        type: 'user',
        content: rawInput.trim(),
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      const userInput = rawInput.trim();
      setInputValue('');
      setIsTyping(true);

      try {
        const lowerInput = userInput.toLowerCase().trim();

        if (lowerInput === '/clear') {
          handleClearChat();
          setIsTyping(false);
          return;
        }

        if (lowerInput === '/status' || lowerInput === '/monitor') {
          setIsTyping(false);
          await handleMonitor();
          return;
        }

        if (lowerInput.startsWith('/memory-search')) {
          const query = userInput.slice('/memory-search'.length).trim();
          if (!query) {
            const helpMsg: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content: '用法: /memory-search <关键词>\n\n例如: /memory-search 项目配置',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, helpMsg]);
          } else {
            const result = await apiService.searchMemory(query);
            if (result.success && result.data) {
              const data = result.data as MemorySearchResponse;
              const results = data.results ?? [];
              let content = `**🧠 记忆搜索结果: "${query}"**\n\n`;
              if (results.length === 0) {
                content += '未找到相关记忆。';
              } else {
                results.slice(0, 5).forEach((r: { content: string; similarity: number }, i: number) => {
                  content += `${i + 1}. ${r.content} (相似度: ${(r.similarity * 100).toFixed(1)}%)\n`;
                });
              }
              const response: Message = {
                id: Date.now() + 1,
                type: 'assistant',
                content,
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, response]);
            } else {
              const fallback: Message = {
                id: Date.now() + 1,
                type: 'assistant',
                content: `搜索记忆"${query}"失败，请确保后端服务已启动。`,
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, fallback]);
            }
          }
          setIsTyping(false);
          return;
        }

        if (lowerInput === '/help') {
          const helpMsg: Message = {
            id: Date.now() + 1,
            type: 'assistant',
            content: `**可用命令：**
- /help - 显示帮助信息
- /status - 查看系统状态
- /clear - 清空对话
- /memory-search <关键词> - 搜索记忆
- /osv-scan - 依赖漏洞扫描
- /disk-cleanup - 磁盘清理预览
- /dir-hints [目录] - 子目录导航提示
- /goal - 目标达成追踪与能力印记

**快捷键：**
- Ctrl+N - 新建对话
- Ctrl+B - 批量处理
- Ctrl+T - 自动化
- Ctrl+G - Vibe编码
- Ctrl+M - 记忆管理
- Ctrl+K - 系统监控
- Ctrl+Enter - 快速发送`,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, helpMsg]);
          setIsTyping(false);
          return;
        }

        if (lowerInput === '/osv-scan') {
          try {
            const result = await apiService.osvScan();
            const data = result.data;
            const response: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content:
                result.success && data
                  ? `**🛡️ 依赖漏洞扫描结果**\n\n🔴 严重: ${data.critical} | 🟠 高危: ${data.high} | 🟡 中危: ${data.medium} | 🟢 低危: ${data.low}\n\n${data.report}`
                  : '**🛡️ 漏洞扫描失败**\n\n请确保后端服务已启动。',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, response]);
          } catch {
            const fallback: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content: '**🛡️ 漏洞扫描失败**\n\n请确保后端服务已启动。',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, fallback]);
          }
          setIsTyping(false);
          return;
        }

        if (lowerInput === '/disk-cleanup') {
          try {
            const result = await apiService.diskCleanup(undefined, ['all'], false, true);
            const data = result.data;
            const response: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content:
                result.success && data
                  ? `**🧹 磁盘清理预览**\n\n可清理: ${data.totalItems}项, 可释放: ${(data.totalSize / (1024 * 1024)).toFixed(1)}MB\n\n${data.report}\n\n⚠️ 预览模式，未实际删除。使用 /disk-cleanup-confirm 执行清理。`
                  : '**🧹 磁盘清理扫描失败**\n\n请确保后端服务已启动。',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, response]);
          } catch {
            const fallback: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content: '**🧹 磁盘清理扫描失败**\n\n请确保后端服务已启动。',
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, fallback]);
          }
          setIsTyping(false);
          return;
        }

        if (lowerInput.startsWith('/dir-hints')) {
          const dir = userInput.slice('/dir-hints'.length).trim() || '.';
          try {
            const result = await apiService.subdirectoryHints(dir);
            const data = result.data;
            const response: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content:
                result.success && data
                  ? `**📂 子目录导航** (${data.totalDirs}个目录)\n\n${data.hints}`
                  : `**📂 目录分析失败**\n\n无法分析目录 "${dir}"`,
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, response]);
          } catch {
            const fallback: Message = {
              id: Date.now() + 1,
              type: 'assistant',
              content: `**📂 目录分析失败**\n\n无法分析目录 "${dir}"`,
              timestamp: new Date(),
            };
            setMessages((prev) => [...prev, fallback]);
          }
          setIsTyping(false);
          return;
        }

        if (lowerInput === '/goal' || lowerInput === '/goals') {
          const assistantCount = messages.filter((m) => m.type === 'assistant').length;
          const toolCount = toolTraces.length;
          const goalMsg: Message = {
            id: Date.now() + 1,
            type: 'assistant',
            content: `**🎯 Agent 目标达成追踪**

**会话统计**
- 对话轮数: ${assistantCount}
- 工具调用: ${toolCount}
- 记忆记录: ${memoryStats?.totalRecords ?? 'N/A'}
- 预算消耗: ${tokenUsed.toLocaleString()} tokens / $${costUsed.toFixed(2)}

**执行印记**
${
  executionUpdates.length > 0
    ? executionUpdates
        .slice(-5)
        .map((u, i) => `${i + 1}. ${u.status || '状态更新'}`)
        .join('\n')
    : '暂无执行记录'
}

**能力标签**
- 🔧 工具执行: ${toolCount > 0 ? '已激活' : '待激活'}
- 🧠 记忆检索: ${memoryStats ? '在线' : '离线'}
- ⚡ 批量处理: 待配置
- 🛡️ 安全检查: 自动
- 🎯 目标达成: ${assistantCount > 3 ? '高效' : assistantCount > 1 ? '正常' : '起步中'}`,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, goalMsg]);
          setIsTyping(false);
          return;
        }

        const result = await apiService.processMessage(userInput);
        if (result.success && result.data) {
          let responseContent = result.data.response || '';
          if (!responseContent.trim()) {
            if (result.data.finishReason === 'budget_exceeded') {
              responseContent = '抱歉，当前AI服务预算已达上限，暂时无法处理更多请求。请稍后重试。';
            } else if (result.data.finishReason === 'fallback') {
              responseContent = await simulateAIResponse(userInput);
            } else {
              responseContent = '抱歉，未能生成有效响应，请稍后重试。';
            }
          }
          const assistantMessage: Message = {
            id: Date.now() + 1,
            type: 'assistant',
            content: responseContent,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
        } else {
          const errorContent = result.error ? `请求失败：${result.error}` : await simulateAIResponse(userInput);
          const assistantMessage: Message = {
            id: Date.now() + 1,
            type: 'assistant',
            content: errorContent,
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }
      } catch (err) {
        console.error('[DesktopDashboard] processMessage failed:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes('超时') || errMsg.includes('timeout');
        const fallbackContent = isTimeout ? '抱歉，请求超时，请稍后重试。' : await simulateAIResponse(userInput);
        const assistantMessage: Message = {
          id: Date.now() + 1,
          type: 'assistant',
          content: fallbackContent,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } finally {
        setIsTyping(false);
      }
    },
    [
      inputValue,
      addRecentCommand,
      handleClearChat,
      handleMonitor,
      messages,
      toolTraces,
      memoryStats,
      executionUpdates,
      tokenUsed,
      costUsed,
    ]
  );

  const handleNodeClick = useCallback(
    (node: FeatureNode) => {
      toast.showInfo(`已选择 ${node.label}`);

      switch (node.id) {
        case 'clarify':
          setInputValue('请帮我澄清并确认这个需求边界：');
          inputRef.current?.focus();
          break;
        case 'todo':
          handleSend('/todo 请帮我拆解当前任务');
          break;
        case 'sandbox':
          setInputValue('请在沙箱中执行以下代码：');
          inputRef.current?.focus();
          break;
        case 'subagent':
          setInputValue('请为我委派一个子Agent处理以下任务：');
          inputRef.current?.focus();
          break;
        case 'approval':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              type: 'system',
              content: '✅ 写入审批已启用：所有文件变更操作将需要您的确认。',
              timestamp: new Date(),
            },
          ]);
          break;
        case 'budget':
          handleSend('/goal');
          break;
        case 'osv':
          handleSend('/osv-scan');
          break;
        case 'cleanup':
          handleSend('/disk-cleanup');
          break;
        case 'voice':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              type: 'system',
              content: '🎙️ 语音对话模式：点击输入框右侧麦克风图标开始语音输入（需要后端语音服务）。',
              timestamp: new Date(),
            },
          ]);
          break;
        case 'workspace':
          navigateTo('settings' as any);
          break;
        case 'i18n':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              type: 'system',
              content: '🌐 国际化支持：家百星支持多语言界面切换，当前为中文（zh-CN）。',
              timestamp: new Date(),
            },
          ]);
          break;
        case 'plugin':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now(),
              type: 'system',
              content: '🔌 插件系统：通过插件扩展Agent能力，支持自定义工具、技能和网关适配器。',
              timestamp: new Date(),
            },
          ]);
          break;
        default:
          setInputValue(`${node.label}：`);
          inputRef.current?.focus();
      }
    },
    [navigateTo, toast, handleSend]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        handleClearChat();
        return;
      }
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        handleBatchProcess();
        return;
      }
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        handleAutomation();
        return;
      }
      if (e.ctrlKey && e.key === 'g') {
        e.preventDefault();
        handleVibeCoding();
        return;
      }
      if (e.ctrlKey && e.key === 'm') {
        e.preventDefault();
        handleMemory();
        return;
      }
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        handleMonitor();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleClearChat,
    handleBatchProcess,
    handleAutomation,
    handleVibeCoding,
    handleMemory,
    handleMonitor,
    handleSend,
  ]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && preferences.sendOnEnter) {
      e.preventDefault();
      handleSend();
    }
  };

  const inputPlaceholder = preferences.sendOnEnter
    ? '输入消息... (Enter发送, Shift+Enter换行)'
    : '输入消息... (Ctrl+Enter发送, Enter换行)';

  const [showSettings, setShowSettings] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);

  const latestUpdates = executionUpdates.slice(-5);
  const latestTraces = toolTraces.slice(-3);
  const quickNodes = FEATURE_NODES.slice(0, 6);

  return (
    <div className={`hermes-dashboard theme-${theme}`}>
      <div className="hermes-main">
        {/* 左侧：对话工作区 */}
        <div className="hermes-workspace">
          <div className={`hermes-messages hermes-messages--${preferences.messageLayout}`} ref={messagesContainerRef}>
            {messages.map((message) => (
              <div key={message.id} className={`hermes-message hermes-message-${message.type}`}>
                {preferences.showAvatars && message.type !== 'user' && (
                  <span className="message-avatar">{message.type === 'assistant' ? '🤖' : 'ℹ️'}</span>
                )}
                <div className="message-content">
                  <div className="message-text">{formatMessage(message.content)}</div>
                  {preferences.showTimestamps && <span className="message-time">{formatTime(message.timestamp)}</span>}
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="hermes-message hermes-message-assistant hermes-message-typing">
                <span className="message-avatar">🤖</span>
                <div className="message-content">
                  <div className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Agent 印记条 - 家百星专属 */}
          <div className="agent-stamp-bar">
            <div className="agent-stamp-bar__left">
              <span className="agent-stamp-bar__seal">印</span>
              <span className="agent-stamp-bar__goal">
                {isTyping
                  ? 'Agent 正在达成目标...'
                  : messages.length > 2
                    ? `已同行 ${messages.filter((m) => m.type === 'assistant').length} 轮`
                    : '等待同行指令'}
              </span>
            </div>
            <div className="agent-stamp-bar__right">
              <span className="agent-stamp-bar__badge agent-stamp-bar__badge--loop" title="ReAct 执行循环">
                {executionUpdates.length > 0 ? '🔥 执行中' : '⚡ 就绪'}
              </span>
              <span className="agent-stamp-bar__badge agent-stamp-bar__badge--tools" title="已调用工具">
                {toolTraces.length} 工具
              </span>
              <span className="agent-stamp-bar__badge agent-stamp-bar__badge--memory" title="记忆库">
                {memoryStats ? `${memoryStats.totalRecords ?? 0} 记忆` : '记忆待启'}
              </span>
            </div>
          </div>

          {/* Hermes 风格输入区：左侧+号，中间输入，右侧模型+语音+发送 */}
          <div className="hermes-input-area hermes-input-area--v2">
            <div className="input-tools">
              <button
                className="input-tools-btn"
                onClick={() => setShowShortcuts(!showShortcuts)}
                title="快捷工具"
                aria-label="快捷工具"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              {showShortcuts && (
                <div className="input-tools-menu">
                  {shortcuts.map((sc) => (
                    <button
                      key={sc.id}
                      className="input-tools-menu-item"
                      onClick={() => {
                        sc.action();
                        setShowShortcuts(false);
                      }}
                    >
                      <span className="tools-menu-icon">{sc.icon}</span>
                      <span className="tools-menu-label">{sc.label}</span>
                      <kbd className="tools-menu-key">{sc.shortcut.replace('Ctrl+', '⌃')}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea
              ref={inputRef}
              className="hermes-input"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                adjustTextareaHeight();
              }}
              onKeyPress={handleKeyPress}
              placeholder={inputPlaceholder}
              rows={1}
            />
            <div className="input-actions">
              <button className="input-model-btn" title="模型选择">
                <span className="input-model-name">deepseek-v4</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <button className="input-voice-btn" title="语音输入" aria-label="语音输入">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              <button
                className={`hermes-send-btn ${inputValue.trim() ? 'active' : ''}`}
                onClick={() => handleSend()}
                disabled={!inputValue.trim() || isTyping}
                title="发送 (Enter)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>
          </div>

          {/* 底部状态栏 - Hermes 风格（右下角） */}
          <div className="hermes-statusbar hermes-statusbar--v2">
            <span className="statusbar-version">v5.0.0</span>
            <span className="statusbar-dot">•</span>
            <span className="statusbar-session">会话 {activeSessionId?.slice(0, 8) || 'local'}</span>
            <span className="statusbar-dot">•</span>
            <span className="statusbar-time">{currentTime.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          </div>
        </div>

        {/* 右侧：折叠面板（默认隐藏，点击展开） */}
        <aside className={`hermes-right-sidebar ${showRightPanel ? 'open' : ''}`}>
          {!showRightPanel ? (
            <button
              className="sidebar-expand-btn"
              onClick={() => setShowRightPanel(true)}
              title="展开信息面板"
              aria-label="展开信息面板"
            >
              ◀
            </button>
          ) : (
            <>
              <div className="sidebar-expand-header">
                <span className="sidebar-expand-title">Agent 印记</span>
                <button
                  className="sidebar-expand-close"
                  onClick={() => setShowRightPanel(false)}
                  title="收起"
                  aria-label="收起信息面板"
                >
                  ▶
                </button>
              </div>

              {/* 快速能力 */}
              <div className="dashboard-card dashboard-card--compact">
                <div className="dashboard-card__header">
                  <span className="dashboard-card__title">⚡ 快速能力</span>
                </div>
                <div className="dashboard-card__body">
                  <ul className="quick-nodes">
                    {quickNodes.map((node) => (
                      <li key={node.id}>
                        <button
                          className="quick-node-btn"
                          onClick={() => handleNodeClick(node)}
                          title={node.description}
                          aria-label={`${node.label}: ${node.description}`}
                          style={{ '--node-accent': node.color } as React.CSSProperties}
                        >
                          <span className="quick-node-icon" aria-hidden="true">
                            {node.icon}
                          </span>
                          <span className="quick-node-label">{node.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Agent 执行印记 */}
              <div className="dashboard-card">
                <div className="dashboard-card__header">
                  <span className="dashboard-card__title">🤖 Agent 动态</span>
                </div>
                <div className="dashboard-card__body">
                  {latestTraces.length === 0 && latestUpdates.length === 0 ? (
                    <div className="dashboard-empty">开始对话后显示</div>
                  ) : (
                    <div className="agent-feed">
                      {latestTraces.map((t, i) => (
                        <div key={`trace-${i}`} className="agent-feed__item">
                          <span className="agent-feed__icon">🔧</span>
                          <span className="agent-feed__text">{t.toolName || '工具调用'}</span>
                        </div>
                      ))}
                      {latestUpdates.map((u, i) => (
                        <div key={`update-${i}`} className="agent-feed__item">
                          <span className="agent-feed__icon">🧠</span>
                          <span className="agent-feed__text">{u.status || '执行更新'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 记忆库快照 */}
              <div className="dashboard-card">
                <div className="dashboard-card__header">
                  <span className="dashboard-card__title">🧠 记忆快照</span>
                </div>
                <div className="dashboard-card__body">
                  {memoryStats ? (
                    <div className="memory-snapshot">
                      <div className="memory-snapshot__stat">
                        <span className="memory-snapshot__value">{memoryStats.totalRecords ?? 0}</span>
                        <span className="memory-snapshot__label">记录</span>
                      </div>
                      <div className="memory-snapshot__stat">
                        <span className="memory-snapshot__value">{memoryStats.databaseSizeMB?.toFixed(1) ?? 0} MB</span>
                        <span className="memory-snapshot__label">大小</span>
                      </div>
                      {memoryStats.typeDistribution && (
                        <div className="memory-snapshot__distribution">
                          {Object.entries(memoryStats.typeDistribution)
                            .slice(0, 4)
                            .map(([type, count]) => (
                              <div key={type} className="memory-snapshot__type">
                                <span className="memory-snapshot__type-name">{type}</span>
                                <span className="memory-snapshot__type-count">{count as number}</span>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  ) : !dashboardDataLoaded ? (
                    <div className="skeleton skeleton--memory">
                      <div className="skeleton__line skeleton__line--w60" />
                      <div className="skeleton__line skeleton__line--w40" />
                      <div className="skeleton__line skeleton__line--w50" />
                    </div>
                  ) : (
                    <div className="dashboard-empty">连接后端查看记忆</div>
                  )}
                </div>
              </div>

              {/* W4-5: 系统资源监控（真实数据） */}
              <div className="dashboard-card">
                <div className="dashboard-card__header">
                  <span className="dashboard-card__title">📊 系统监控</span>
                </div>
                <div className="dashboard-card__body">
                  {systemResources ? (
                    <div className="system-monitor">
                      <div className="system-monitor__item">
                        <span className="system-monitor__label">内存</span>
                        <div className="system-monitor__bar">
                          <div
                            className="system-monitor__bar-fill"
                            style={{
                              width: `${systemResources.memory?.usagePercent ?? 0}%`,
                              backgroundColor:
                                (systemResources.memory?.usagePercent ?? 0) > 80
                                  ? '#ef4444'
                                  : (systemResources.memory?.usagePercent ?? 0) > 60
                                    ? '#f59e0b'
                                    : '#22c55e',
                            }}
                          />
                        </div>
                        <span className="system-monitor__value">
                          {systemResources.memory?.usagePercent?.toFixed(0) ?? 0}%
                        </span>
                      </div>
                      <div className="system-monitor__detail">
                        堆: {systemResources.memory?.heapUsed ?? '-'} / {systemResources.memory?.heapTotal ?? '-'} MB
                      </div>
                      {systemResources.cpu?.loadAverage && (
                        <div className="system-monitor__item">
                          <span className="system-monitor__label">CPU</span>
                          <span className="system-monitor__value">
                            {systemResources.cpu.loadAverage.map((v: number) => v.toFixed(2)).join(', ')}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : healthStatus ? (
                    <div className="system-monitor">
                      <div className="system-monitor__item">
                        <span className="system-monitor__label">状态</span>
                        <span
                          className="system-monitor__value"
                          style={{ color: healthStatus.status === 'ok' ? '#22c55e' : '#f59e0b' }}
                        >
                          {healthStatus.status ?? 'unknown'}
                        </span>
                      </div>
                      {healthStatus.uptime != null && (
                        <div className="system-monitor__detail">
                          运行: {Math.floor(healthStatus.uptime / 3600)}h{' '}
                          {Math.floor((healthStatus.uptime % 3600) / 60)}m
                        </div>
                      )}
                    </div>
                  ) : !dashboardDataLoaded ? (
                    <div className="skeleton skeleton--monitor">
                      <div className="skeleton__bar" />
                      <div className="skeleton__line skeleton__line--w70" />
                      <div className="skeleton__bar" />
                    </div>
                  ) : (
                    <div className="dashboard-empty">连接后端查看监控</div>
                  )}
                </div>
              </div>

              {/* W4-5: 技能列表（真实数据） */}
              <div className="dashboard-card dashboard-card--compact">
                <div className="dashboard-card__header">
                  <span className="dashboard-card__title">🔧 技能 ({skillList.length})</span>
                </div>
                <div className="dashboard-card__body">
                  {skillList.length > 0 ? (
                    <ul className="skill-list">
                      {skillList.slice(0, 8).map((skill) => (
                        <li key={skill.name} className="skill-list__item" title={skill.description}>
                          <span className="skill-list__name">{skill.name}</span>
                          {skill.category && <span className="skill-list__category">{skill.category}</span>}
                        </li>
                      ))}
                      {skillList.length > 8 && <li className="skill-list__more">+{skillList.length - 8} 更多</li>}
                    </ul>
                  ) : !dashboardDataLoaded ? (
                    <ul className="skill-list">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <li key={i} className="skill-list__item">
                          <span className="skeleton__line skeleton__line--w50" />
                          <span className="skeleton__line skeleton__line--w20" />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="dashboard-empty">连接后端查看技能</div>
                  )}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {showSettings && (
        <>
          <div className="hermes-settings-overlay" onClick={() => setShowSettings(false)} />
          <div className="hermes-settings-panel">
            <div className="hermes-settings-title">偏好设置</div>

            <div className="hermes-settings-group">
              <div className="hermes-settings-group-title">显示</div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">字体大小</div>
                </div>
                <select
                  className="hermes-select"
                  value={preferences.fontSize}
                  onChange={(e) => setPreference('fontSize', Number(e.target.value))}
                >
                  <option value={12}>12px</option>
                  <option value={13}>13px</option>
                  <option value={14}>14px</option>
                  <option value={15}>15px</option>
                  <option value={16}>16px</option>
                </select>
              </div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">消息布局</div>
                </div>
                <select
                  className="hermes-select"
                  value={preferences.messageLayout}
                  onChange={(e) =>
                    setPreference('messageLayout', e.target.value as 'compact' | 'comfortable' | 'spacious')
                  }
                >
                  <option value="compact">紧凑</option>
                  <option value="comfortable">舒适</option>
                  <option value="spacious">宽松</option>
                </select>
              </div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">显示时间戳</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.showTimestamps ? 'active' : ''}`}
                  onClick={() => setPreference('showTimestamps', !preferences.showTimestamps)}
                />
              </div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">显示头像</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.showAvatars ? 'active' : ''}`}
                  onClick={() => setPreference('showAvatars', !preferences.showAvatars)}
                />
              </div>
            </div>

            <div className="hermes-settings-group">
              <div className="hermes-settings-group-title">交互</div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">Enter发送</div>
                  <div className="hermes-settings-desc">关闭后需Ctrl+Enter发送</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.sendOnEnter ? 'active' : ''}`}
                  onClick={() => setPreference('sendOnEnter', !preferences.sendOnEnter)}
                />
              </div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">自动滚动</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.autoScroll ? 'active' : ''}`}
                  onClick={() => setPreference('autoScroll', !preferences.autoScroll)}
                />
              </div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">声音提示</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.soundEnabled ? 'active' : ''}`}
                  onClick={() => setPreference('soundEnabled', !preferences.soundEnabled)}
                />
              </div>
            </div>

            <div className="hermes-settings-group">
              <div className="hermes-settings-group-title">通知</div>
              <div className="hermes-settings-item">
                <div>
                  <div className="hermes-settings-label">桌面通知</div>
                </div>
                <div
                  className={`hermes-toggle ${preferences.notificationEnabled ? 'active' : ''}`}
                  onClick={() => setPreference('notificationEnabled', !preferences.notificationEnabled)}
                />
              </div>
            </div>

            <div className="hermes-settings-group">
              <div className="hermes-settings-group-title">最近命令</div>
              {preferences.recentCommands.length === 0 ? (
                <div style={{ color: 'var(--hermes-text-dim)', fontSize: '12px' }}>暂无记录</div>
              ) : (
                preferences.recentCommands.slice(0, 8).map((cmd: string, i: number) => (
                  <div key={i} className="hermes-settings-item">
                    <span className="hermes-settings-label" style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                      {cmd}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

async function simulateAIResponse(input: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));

  const lowerInput = input.toLowerCase().trim();

  if (lowerInput === '/help') {
    return `**可用命令：**
- /help - 显示帮助信息
- /status - 查看系统状态
- /clear - 清空对话
- /memory-search <关键词> - 搜索记忆

**功能模块：**
- 💬 对话模式：自然语言交互
- ⚡ 批量处理：并行执行多个任务
- 🤖 自动化：配置自动化工作流
- ✨ 编码辅助：智能代码生成与优化`;
  }

  if (lowerInput === '/status') {
    return `**系统状态报告**
\`\`\`
┌─────────────────────────────┐
│ CPU 使用率:     23%         │
│ 内存使用率:     58% (2.3GB) │
│ 活跃连接数:     3           │
│ 今日任务完成:   17          │
│ 运行时间:       4h 32m      │
│ AI模型:         deepseek-v4 │
│ API响应时间:    ~1.2s       │
└─────────────────────────────┘
\`\`\``;
  }

  if (lowerInput.startsWith('/')) {
    return `❓ 未知命令: \`${input}\`\n\n输入 \`/help\` 查看可用命令`;
  }

  const greetingKeywords = ['你好', '您好', 'hi', 'hello', '嗨', 'hey'];
  if (greetingKeywords.some((kw) => lowerInput === kw || lowerInput === kw + '？' || lowerInput === kw + '?')) {
    return `你好！我是家百星，您的智能AI助手。我拥有丰富的工具和能力，可以帮助您完成各种任务。请问有什么可以帮您的吗？`;
  }

  const identityKeywords = ['你是', '你叫', '什么名字', 'who are you', '你是谁', '介绍一下'];
  if (identityKeywords.some((kw) => lowerInput.includes(kw))) {
    return `我是家百星（Jiabaixing），一个智能AI助手。我拥有丰富的工具和能力，包括对话交互、工具执行、记忆检索、批量处理等。有什么需要我帮忙的吗？`;
  }

  const responses = [
    `关于"${input}"，我的分析如下：

**现状评估**
当前情况显示这是一个值得关注的领域。

**关键发现**
- 数据表明存在优化的空间
- 通过系统性改进可以显著提升效果

**建议方案**
1. 首先进行全面的诊断分析
2. 制定分阶段的实施计划
3. 建立监控和反馈机制

需要我提供更详细的实施方案吗？`,

    `感谢您的提问！

针对您提到的"${input}"，我从以下几个维度进行分析：

**技术层面**
这涉及到核心架构的设计理念和实现方式。

**实践层面**
在实际应用中，我们需要考虑可维护性和扩展性。

**未来展望**
随着技术的发展，这个领域还有很大的创新空间。

如果您有具体的应用场景，我可以为您提供更有针对性的建议。`,
  ];

  return responses[Math.floor(Math.random() * responses.length)];
}

function formatMessage(content: string): React.ReactNode {
  const codeBlockRegex = /```([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIndex = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...formatInlineContent(content.slice(lastIndex, match.index), keyIndex));
      keyIndex += 10;
    }
    const codeContent = match[1].trim();
    parts.push(
      <pre key={`code-${keyIndex++}`} className="message-code-block">
        <code>{codeContent}</code>
      </pre>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(...formatInlineContent(content.slice(lastIndex), keyIndex));
  }

  return parts;
}

function formatInlineContent(text: string, baseKey: number): React.ReactNode[] {
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `inline-${baseKey}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="message-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    const lines = part.split('\n');
    return lines.map((line, i) => (
      <React.Fragment key={`${key}-${i}`}>
        {i > 0 && <br />}
        {line}
      </React.Fragment>
    ));
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export default DesktopDashboard;
