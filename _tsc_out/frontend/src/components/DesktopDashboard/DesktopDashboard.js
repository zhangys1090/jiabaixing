"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopDashboard = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = __importStar(require("react"));
const apiService_1 = require("../../api/apiService");
const ThemeContext_1 = require("../../contexts/ThemeContext");
const ToastContext_1 = require("../../contexts/ToastContext");
const useUserPreferences_1 = require("../../hooks/useUserPreferences");
const useAgentStore_1 = require("../../stores/useAgentStore");
const useBudgetStore_1 = require("../../stores/useBudgetStore");
const useWorkspaceStore_1 = require("../../stores/useWorkspaceStore");
require("./DesktopDashboard.css");
const FeatureNodeGrid_1 = require("./FeatureNodeGrid");
const STORAGE_KEY_MESSAGES = 'jiabaixing-dashboard-messages';
const MAX_STORED_MESSAGES = 100;
function loadStoredMessages() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0)
            return null;
        return parsed.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
    }
    catch {
        return null;
    }
}
function saveMessages(messages) {
    try {
        const toStore = messages.slice(-MAX_STORED_MESSAGES);
        localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(toStore));
    }
    catch {
        /* ignore */
    }
}
const WELCOME_MESSAGES = [
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
const DesktopDashboard = ({ onNavigate }) => {
    const { theme } = (0, ThemeContext_1.useTheme)();
    const toast = (0, ToastContext_1.useToast)();
    const { preferences, setPreference, addRecentCommand } = (0, useUserPreferences_1.useUserPreferences)();
    const executionUpdates = (0, useAgentStore_1.useAgentStore)((s) => s.executionUpdates);
    const toolTraces = (0, useAgentStore_1.useAgentStore)((s) => s.toolTraces);
    const tokenUsed = (0, useBudgetStore_1.useBudgetStore)((s) => s.tokenUsed);
    const costUsed = (0, useBudgetStore_1.useBudgetStore)((s) => s.costUsed);
    const fetchBudgetStatus = (0, useBudgetStore_1.useBudgetStore)((s) => s.fetchBudgetStatus);
    const [inputValue, setInputValue] = (0, react_1.useState)('');
    const [messages, setMessages] = (0, react_1.useState)(() => {
        const stored = loadStoredMessages();
        return stored || WELCOME_MESSAGES;
    });
    const [isTyping, setIsTyping] = (0, react_1.useState)(false);
    const [currentTime, setCurrentTime] = (0, react_1.useState)(new Date());
    const [memoryStats, setMemoryStats] = (0, react_1.useState)(null);
    const [systemResources, setSystemResources] = (0, react_1.useState)(null);
    const [healthStatus, setHealthStatus] = (0, react_1.useState)(null);
    const [skillList, setSkillList] = (0, react_1.useState)([]);
    const [dashboardDataLoaded, setDashboardDataLoaded] = (0, react_1.useState)(false);
    const messagesEndRef = (0, react_1.useRef)(null);
    const inputRef = (0, react_1.useRef)(null);
    const messagesContainerRef = (0, react_1.useRef)(null);
    const adjustTextareaHeight = (0, react_1.useCallback)(() => {
        const el = inputRef.current;
        if (!el)
            return;
        el.style.height = 'auto';
        const newHeight = Math.min(Math.max(el.scrollHeight, 40), 120);
        el.style.height = `${newHeight}px`;
    }, []);
    (0, react_1.useEffect)(() => {
        adjustTextareaHeight();
    }, [inputValue, adjustTextareaHeight]);
    (0, react_1.useEffect)(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);
    (0, react_1.useEffect)(() => {
        document.documentElement.style.setProperty('--hermes-font-size', `${preferences.fontSize}px`);
    }, [preferences.fontSize]);
    (0, react_1.useEffect)(() => {
        if (messages.length > 0) {
            saveMessages(messages);
        }
    }, [messages]);
    const loadMemoryStats = (0, react_1.useCallback)(async () => {
        try {
            const result = await apiService_1.apiService.getMemoryStats();
            if (result.success && result.data) {
                setMemoryStats(result.data);
            }
        }
        catch {
            /* 静默失败，记忆服务非必须 */
        }
    }, []);
    const loadDashboardData = (0, react_1.useCallback)(async () => {
        try {
            const [memResult, resResult, healthResult, skillResult] = await Promise.allSettled([
                apiService_1.apiService.getMemoryStats(),
                apiService_1.apiService.getSystemResources(),
                apiService_1.apiService.getHealth(),
                apiService_1.apiService.listSkills(),
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
                const skills = skillResult.value.data;
                setSkillList(skills.skills ?? []);
            }
        }
        catch {
            /* 静默失败 */
        }
        finally {
            setDashboardDataLoaded(true);
        }
    }, []);
    const scrollToBottom = (0, react_1.useCallback)(() => {
        const element = messagesEndRef.current;
        if (element && typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ behavior: 'smooth' });
        }
    }, []);
    (0, react_1.useEffect)(() => {
        scrollToBottom();
    }, [messages, isTyping, scrollToBottom]);
    (0, react_1.useEffect)(() => {
        inputRef.current?.focus();
    }, []);
    const navigateTo = (0, react_1.useCallback)((view) => {
        if (onNavigate) {
            onNavigate(view);
            toast.showInfo(`已切换到${view}面板`);
        }
    }, [onNavigate, toast]);
    const handleClearChat = (0, react_1.useCallback)(() => {
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
    const handleBatchProcess = (0, react_1.useCallback)(() => {
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
    const handleAutomation = (0, react_1.useCallback)(() => {
        navigateTo('automation');
    }, [navigateTo]);
    const handleVibeCoding = (0, react_1.useCallback)(() => {
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
    const handleMemory = (0, react_1.useCallback)(async () => {
        const msg = {
            id: Date.now(),
            type: 'system',
            content: '🧠 正在查询记忆库...',
            timestamp: new Date(),
        };
        setMessages((prev) => [...prev, msg]);
        try {
            const result = await apiService_1.apiService.getMemoryStats();
            if (result.success && result.data) {
                const stats = result.data;
                const response = {
                    id: Date.now() + 1,
                    type: 'assistant',
                    content: `**🧠 记忆库状态**

- 总记录数: ${stats.totalRecords ?? 'N/A'}
- 数据库大小: ${stats.databaseSizeMB ?? 'N/A'} MB
- 类型分布: ${stats.typeDistribution
                        ? Object.entries(stats.typeDistribution)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(', ')
                        : 'N/A'}
- 最近更新: ${stats.timestamp ?? 'N/A'}

输入 /memory-search <关键词> 搜索记忆，或点击侧栏"记忆"面板进行管理。`,
                    timestamp: new Date(),
                };
                setMessages((prev) => [...prev, response]);
            }
            else {
                const fallback = {
                    id: Date.now() + 1,
                    type: 'assistant',
                    content: '**🧠 记忆管理**\n\n记忆库暂未连接，请确保后端服务已启动。\n\n您也可以点击侧栏"记忆"面板进行管理。',
                    timestamp: new Date(),
                };
                setMessages((prev) => [...prev, fallback]);
            }
        }
        catch {
            const fallback = {
                id: Date.now() + 1,
                type: 'assistant',
                content: '**🧠 记忆管理**\n\n记忆库暂未连接，请确保后端服务已启动。\n\n您也可以点击侧栏"记忆"面板进行管理。',
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, fallback]);
        }
    }, []);
    const handleMonitor = (0, react_1.useCallback)(async () => {
        const msg = {
            id: Date.now(),
            type: 'system',
            content: '📊 正在获取系统状态...',
            timestamp: new Date(),
        };
        setMessages((prev) => [...prev, msg]);
        try {
            const [healthResult, resourcesResult] = await Promise.all([
                apiService_1.apiService.getHealth(),
                apiService_1.apiService.getSystemResources(),
            ]);
            let content = '**📊 系统监控报告**\n\n';
            if (healthResult.success && healthResult.data) {
                const health = healthResult.data;
                content += `**健康状态**: ${health.status ?? 'unknown'}\n`;
                content += `**版本**: ${health.model ?? 'N/A'}\n`;
                content += `**运行时间**: ${health.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : 'N/A'}\n\n`;
            }
            if (resourcesResult.success && resourcesResult.data) {
                const res = resourcesResult.data;
                content += `**内存使用率**: ${res.memory?.usagePercent ?? 'N/A'}%\n`;
                content += `**堆内存**: ${res.memory?.heapUsed ?? 'N/A'} / ${res.memory?.heapTotal ?? 'N/A'} MB\n`;
                content += `**CPU 负载**: ${res.cpu?.loadAverage ? res.cpu.loadAverage.map((v) => v.toFixed(2)).join(', ') : 'N/A'}\n`;
                content += `**磁盘使用**: ${res.disk?.used ?? 'N/A'} / ${res.disk?.total ?? 'N/A'} GB\n`;
            }
            else {
                content += '⚠️ 系统资源数据暂不可用，请确保后端服务已启动。';
            }
            content += '\n\n点击侧栏"监控"面板查看更多详情。';
            const response = {
                id: Date.now() + 1,
                type: 'assistant',
                content,
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, response]);
        }
        catch {
            const fallback = {
                id: Date.now() + 1,
                type: 'assistant',
                content: '**📊 系统监控**\n\n无法获取系统状态，请确保后端服务已启动。\n\n您也可以点击侧栏"监控"面板查看详情。',
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, fallback]);
        }
    }, []);
    (0, react_1.useEffect)(() => {
        fetchBudgetStatus();
        loadDashboardData();
        const interval = setInterval(() => {
            fetchBudgetStatus();
            loadDashboardData();
        }, 30000);
        return () => clearInterval(interval);
    }, [fetchBudgetStatus, loadDashboardData]);
    const shortcuts = (0, react_1.useMemo)(() => [
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
    ], [handleClearChat, handleBatchProcess, handleAutomation, handleVibeCoding, handleMemory]);
    const handleSend = (0, react_1.useCallback)(async (explicitInput) => {
        const rawInput = explicitInput ?? inputValue;
        if (!rawInput.trim())
            return;
        if (rawInput.startsWith('/')) {
            addRecentCommand(rawInput.split(' ')[0]);
        }
        const userMessage = {
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
                    const helpMsg = {
                        id: Date.now() + 1,
                        type: 'assistant',
                        content: '用法: /memory-search <关键词>\n\n例如: /memory-search 项目配置',
                        timestamp: new Date(),
                    };
                    setMessages((prev) => [...prev, helpMsg]);
                }
                else {
                    const result = await apiService_1.apiService.searchMemory(query);
                    if (result.success && result.data) {
                        const data = result.data;
                        const results = data.results ?? [];
                        let content = `**🧠 记忆搜索结果: "${query}"**\n\n`;
                        if (results.length === 0) {
                            content += '未找到相关记忆。';
                        }
                        else {
                            results.slice(0, 5).forEach((r, i) => {
                                content += `${i + 1}. ${r.content} (相似度: ${(r.similarity * 100).toFixed(1)}%)\n`;
                            });
                        }
                        const response = {
                            id: Date.now() + 1,
                            type: 'assistant',
                            content,
                            timestamp: new Date(),
                        };
                        setMessages((prev) => [...prev, response]);
                    }
                    else {
                        const fallback = {
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
                const helpMsg = {
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
                    const result = await apiService_1.apiService.osvScan();
                    const data = result.data;
                    const response = {
                        id: Date.now() + 1,
                        type: 'assistant',
                        content: result.success && data
                            ? `**🛡️ 依赖漏洞扫描结果**\n\n🔴 严重: ${data.critical} | 🟠 高危: ${data.high} | 🟡 中危: ${data.medium} | 🟢 低危: ${data.low}\n\n${data.report}`
                            : '**🛡️ 漏洞扫描失败**\n\n请确保后端服务已启动。',
                        timestamp: new Date(),
                    };
                    setMessages((prev) => [...prev, response]);
                }
                catch {
                    const fallback = {
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
                    const result = await apiService_1.apiService.diskCleanup(undefined, ['all'], false, true);
                    const data = result.data;
                    const response = {
                        id: Date.now() + 1,
                        type: 'assistant',
                        content: result.success && data
                            ? `**🧹 磁盘清理预览**\n\n可清理: ${data.totalItems}项, 可释放: ${(data.totalSize / (1024 * 1024)).toFixed(1)}MB\n\n${data.report}\n\n⚠️ 预览模式，未实际删除。使用 /disk-cleanup-confirm 执行清理。`
                            : '**🧹 磁盘清理扫描失败**\n\n请确保后端服务已启动。',
                        timestamp: new Date(),
                    };
                    setMessages((prev) => [...prev, response]);
                }
                catch {
                    const fallback = {
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
                    const result = await apiService_1.apiService.subdirectoryHints(dir);
                    const data = result.data;
                    const response = {
                        id: Date.now() + 1,
                        type: 'assistant',
                        content: result.success && data
                            ? `**📂 子目录导航** (${data.totalDirs}个目录)\n\n${data.hints}`
                            : `**📂 目录分析失败**\n\n无法分析目录 "${dir}"`,
                        timestamp: new Date(),
                    };
                    setMessages((prev) => [...prev, response]);
                }
                catch {
                    const fallback = {
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
                const goalMsg = {
                    id: Date.now() + 1,
                    type: 'assistant',
                    content: `**🎯 Agent 目标达成追踪**

**会话统计**
- 对话轮数: ${assistantCount}
- 工具调用: ${toolCount}
- 记忆记录: ${memoryStats?.totalRecords ?? 'N/A'}
- 预算消耗: ${tokenUsed.toLocaleString()} tokens / $${costUsed.toFixed(2)}

**执行印记**
${executionUpdates.length > 0
                        ? executionUpdates
                            .slice(-5)
                            .map((u, i) => `${i + 1}. ${u.status || '状态更新'}`)
                            .join('\n')
                        : '暂无执行记录'}

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
            const result = await apiService_1.apiService.processMessage(userInput);
            if (result.success && result.data) {
                let responseContent = result.data.response || '';
                if (!responseContent.trim()) {
                    if (result.data.finishReason === 'budget_exceeded') {
                        responseContent = '抱歉，当前AI服务预算已达上限，暂时无法处理更多请求。请稍后重试。';
                    }
                    else if (result.data.finishReason === 'fallback') {
                        responseContent = await simulateAIResponse(userInput);
                    }
                    else {
                        responseContent = '抱歉，未能生成有效响应，请稍后重试。';
                    }
                }
                const assistantMessage = {
                    id: Date.now() + 1,
                    type: 'assistant',
                    content: responseContent,
                    timestamp: new Date(),
                };
                setMessages((prev) => [...prev, assistantMessage]);
            }
            else {
                const errorContent = result.error ? `请求失败：${result.error}` : await simulateAIResponse(userInput);
                const assistantMessage = {
                    id: Date.now() + 1,
                    type: 'assistant',
                    content: errorContent,
                    timestamp: new Date(),
                };
                setMessages((prev) => [...prev, assistantMessage]);
            }
        }
        catch (err) {
            console.error('[DesktopDashboard] processMessage failed:', err);
            const errMsg = err instanceof Error ? err.message : String(err);
            const isTimeout = errMsg.includes('超时') || errMsg.includes('timeout');
            const fallbackContent = isTimeout ? '抱歉，请求超时，请稍后重试。' : await simulateAIResponse(userInput);
            const assistantMessage = {
                id: Date.now() + 1,
                type: 'assistant',
                content: fallbackContent,
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
        }
        finally {
            setIsTyping(false);
        }
    }, [
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
    ]);
    const handleNodeClick = (0, react_1.useCallback)((node) => {
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
                navigateTo('settings');
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
    }, [navigateTo, toast, handleSend]);
    (0, react_1.useEffect)(() => {
        const handleKeyDown = (e) => {
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
    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && preferences.sendOnEnter) {
            e.preventDefault();
            handleSend();
        }
    };
    const inputPlaceholder = preferences.sendOnEnter
        ? '输入消息... (Enter发送, Shift+Enter换行)'
        : '输入消息... (Ctrl+Enter发送, Enter换行)';
    const [showSettings, setShowSettings] = (0, react_1.useState)(false);
    const [showRightPanel, setShowRightPanel] = (0, react_1.useState)(false);
    const [showShortcuts, setShowShortcuts] = (0, react_1.useState)(false);
    const activeSessionId = (0, useWorkspaceStore_1.useWorkspaceStore)((s) => s.activeSessionId);
    const latestUpdates = executionUpdates.slice(-5);
    const latestTraces = toolTraces.slice(-3);
    const quickNodes = FeatureNodeGrid_1.FEATURE_NODES.slice(0, 6);
    return ((0, jsx_runtime_1.jsxs)("div", { className: `hermes-dashboard theme-${theme}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: "hermes-main", children: [(0, jsx_runtime_1.jsxs)("div", { className: "hermes-workspace", children: [(0, jsx_runtime_1.jsxs)("div", { className: `hermes-messages hermes-messages--${preferences.messageLayout}`, ref: messagesContainerRef, children: [messages.map((message) => ((0, jsx_runtime_1.jsxs)("div", { className: `hermes-message hermes-message-${message.type}`, children: [preferences.showAvatars && message.type !== 'user' && ((0, jsx_runtime_1.jsx)("span", { className: "message-avatar", children: message.type === 'assistant' ? '🤖' : 'ℹ️' })), (0, jsx_runtime_1.jsxs)("div", { className: "message-content", children: [(0, jsx_runtime_1.jsx)("div", { className: "message-text", children: formatMessage(message.content) }), preferences.showTimestamps && (0, jsx_runtime_1.jsx)("span", { className: "message-time", children: formatTime(message.timestamp) })] })] }, message.id))), isTyping && ((0, jsx_runtime_1.jsxs)("div", { className: "hermes-message hermes-message-assistant hermes-message-typing", children: [(0, jsx_runtime_1.jsx)("span", { className: "message-avatar", children: "\uD83E\uDD16" }), (0, jsx_runtime_1.jsx)("div", { className: "message-content", children: (0, jsx_runtime_1.jsxs)("div", { className: "typing-indicator", children: [(0, jsx_runtime_1.jsx)("span", {}), (0, jsx_runtime_1.jsx)("span", {}), (0, jsx_runtime_1.jsx)("span", {})] }) })] })), (0, jsx_runtime_1.jsx)("div", { ref: messagesEndRef })] }), (0, jsx_runtime_1.jsxs)("div", { className: "agent-stamp-bar", children: [(0, jsx_runtime_1.jsxs)("div", { className: "agent-stamp-bar__left", children: [(0, jsx_runtime_1.jsx)("span", { className: "agent-stamp-bar__seal", children: "\u5370" }), (0, jsx_runtime_1.jsx)("span", { className: "agent-stamp-bar__goal", children: isTyping
                                                    ? 'Agent 正在达成目标...'
                                                    : messages.length > 2
                                                        ? `已同行 ${messages.filter((m) => m.type === 'assistant').length} 轮`
                                                        : '等待同行指令' })] }), (0, jsx_runtime_1.jsxs)("div", { className: "agent-stamp-bar__right", children: [(0, jsx_runtime_1.jsx)("span", { className: "agent-stamp-bar__badge agent-stamp-bar__badge--loop", title: "ReAct \u6267\u884C\u5FAA\u73AF", children: executionUpdates.length > 0 ? '🔥 执行中' : '⚡ 就绪' }), (0, jsx_runtime_1.jsxs)("span", { className: "agent-stamp-bar__badge agent-stamp-bar__badge--tools", title: "\u5DF2\u8C03\u7528\u5DE5\u5177", children: [toolTraces.length, " \u5DE5\u5177"] }), (0, jsx_runtime_1.jsx)("span", { className: "agent-stamp-bar__badge agent-stamp-bar__badge--memory", title: "\u8BB0\u5FC6\u5E93", children: memoryStats ? `${memoryStats.totalRecords ?? 0} 记忆` : '记忆待启' })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-input-area hermes-input-area--v2", children: [(0, jsx_runtime_1.jsxs)("div", { className: "input-tools", children: [(0, jsx_runtime_1.jsx)("button", { className: "input-tools-btn", onClick: () => setShowShortcuts(!showShortcuts), title: "\u5FEB\u6377\u5DE5\u5177", "aria-label": "\u5FEB\u6377\u5DE5\u5177", children: (0, jsx_runtime_1.jsxs)("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", children: [(0, jsx_runtime_1.jsx)("line", { x1: "12", y1: "5", x2: "12", y2: "19" }), (0, jsx_runtime_1.jsx)("line", { x1: "5", y1: "12", x2: "19", y2: "12" })] }) }), showShortcuts && ((0, jsx_runtime_1.jsx)("div", { className: "input-tools-menu", children: shortcuts.map((sc) => ((0, jsx_runtime_1.jsxs)("button", { className: "input-tools-menu-item", onClick: () => {
                                                        sc.action();
                                                        setShowShortcuts(false);
                                                    }, children: [(0, jsx_runtime_1.jsx)("span", { className: "tools-menu-icon", children: sc.icon }), (0, jsx_runtime_1.jsx)("span", { className: "tools-menu-label", children: sc.label }), (0, jsx_runtime_1.jsx)("kbd", { className: "tools-menu-key", children: sc.shortcut.replace('Ctrl+', '⌃') })] }, sc.id))) }))] }), (0, jsx_runtime_1.jsx)("textarea", { ref: inputRef, className: "hermes-input", value: inputValue, onChange: (e) => {
                                            setInputValue(e.target.value);
                                            adjustTextareaHeight();
                                        }, onKeyPress: handleKeyPress, placeholder: inputPlaceholder, rows: 1 }), (0, jsx_runtime_1.jsxs)("div", { className: "input-actions", children: [(0, jsx_runtime_1.jsxs)("button", { className: "input-model-btn", title: "\u6A21\u578B\u9009\u62E9", children: [(0, jsx_runtime_1.jsx)("span", { className: "input-model-name", children: "deepseek-v4" }), (0, jsx_runtime_1.jsx)("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", children: (0, jsx_runtime_1.jsx)("polyline", { points: "6 9 12 15 18 9" }) })] }), (0, jsx_runtime_1.jsx)("button", { className: "input-voice-btn", title: "\u8BED\u97F3\u8F93\u5165", "aria-label": "\u8BED\u97F3\u8F93\u5165", children: (0, jsx_runtime_1.jsxs)("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", children: [(0, jsx_runtime_1.jsx)("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }), (0, jsx_runtime_1.jsx)("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }), (0, jsx_runtime_1.jsx)("line", { x1: "12", y1: "19", x2: "12", y2: "23" }), (0, jsx_runtime_1.jsx)("line", { x1: "8", y1: "23", x2: "16", y2: "23" })] }) }), (0, jsx_runtime_1.jsx)("button", { className: `hermes-send-btn ${inputValue.trim() ? 'active' : ''}`, onClick: () => handleSend(), disabled: !inputValue.trim() || isTyping, title: "\u53D1\u9001 (Enter)", children: (0, jsx_runtime_1.jsx)("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", children: (0, jsx_runtime_1.jsx)("path", { d: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" }) }) })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-statusbar hermes-statusbar--v2", children: [(0, jsx_runtime_1.jsx)("span", { className: "statusbar-version", children: "v5.0.0" }), (0, jsx_runtime_1.jsx)("span", { className: "statusbar-dot", children: "\u2022" }), (0, jsx_runtime_1.jsxs)("span", { className: "statusbar-session", children: ["\u4F1A\u8BDD ", activeSessionId?.slice(0, 8) || 'local'] }), (0, jsx_runtime_1.jsx)("span", { className: "statusbar-dot", children: "\u2022" }), (0, jsx_runtime_1.jsx)("span", { className: "statusbar-time", children: currentTime.toLocaleTimeString('zh-CN', { hour12: false }) })] })] }), (0, jsx_runtime_1.jsx)("aside", { className: `hermes-right-sidebar ${showRightPanel ? 'open' : ''}`, children: !showRightPanel ? ((0, jsx_runtime_1.jsx)("button", { className: "sidebar-expand-btn", onClick: () => setShowRightPanel(true), title: "\u5C55\u5F00\u4FE1\u606F\u9762\u677F", "aria-label": "\u5C55\u5F00\u4FE1\u606F\u9762\u677F", children: "\u25C0" })) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "sidebar-expand-header", children: [(0, jsx_runtime_1.jsx)("span", { className: "sidebar-expand-title", children: "Agent \u5370\u8BB0" }), (0, jsx_runtime_1.jsx)("button", { className: "sidebar-expand-close", onClick: () => setShowRightPanel(false), title: "\u6536\u8D77", "aria-label": "\u6536\u8D77\u4FE1\u606F\u9762\u677F", children: "\u25B6" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dashboard-card dashboard-card--compact", children: [(0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__header", children: (0, jsx_runtime_1.jsx)("span", { className: "dashboard-card__title", children: "\u26A1 \u5FEB\u901F\u80FD\u529B" }) }), (0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__body", children: (0, jsx_runtime_1.jsx)("ul", { className: "quick-nodes", children: quickNodes.map((node) => ((0, jsx_runtime_1.jsx)("li", { children: (0, jsx_runtime_1.jsxs)("button", { className: "quick-node-btn", onClick: () => handleNodeClick(node), title: node.description, "aria-label": `${node.label}: ${node.description}`, style: { '--node-accent': node.color }, children: [(0, jsx_runtime_1.jsx)("span", { className: "quick-node-icon", "aria-hidden": "true", children: node.icon }), (0, jsx_runtime_1.jsx)("span", { className: "quick-node-label", children: node.label })] }) }, node.id))) }) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dashboard-card", children: [(0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__header", children: (0, jsx_runtime_1.jsx)("span", { className: "dashboard-card__title", children: "\uD83E\uDD16 Agent \u52A8\u6001" }) }), (0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__body", children: latestTraces.length === 0 && latestUpdates.length === 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "dashboard-empty", children: "\u5F00\u59CB\u5BF9\u8BDD\u540E\u663E\u793A" })) : ((0, jsx_runtime_1.jsxs)("div", { className: "agent-feed", children: [latestTraces.map((t, i) => ((0, jsx_runtime_1.jsxs)("div", { className: "agent-feed__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "agent-feed__icon", children: "\uD83D\uDD27" }), (0, jsx_runtime_1.jsx)("span", { className: "agent-feed__text", children: t.toolName || '工具调用' })] }, `trace-${i}`))), latestUpdates.map((u, i) => ((0, jsx_runtime_1.jsxs)("div", { className: "agent-feed__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "agent-feed__icon", children: "\uD83E\uDDE0" }), (0, jsx_runtime_1.jsx)("span", { className: "agent-feed__text", children: u.status || '执行更新' })] }, `update-${i}`)))] })) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dashboard-card", children: [(0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__header", children: (0, jsx_runtime_1.jsx)("span", { className: "dashboard-card__title", children: "\uD83E\uDDE0 \u8BB0\u5FC6\u5FEB\u7167" }) }), (0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__body", children: memoryStats ? ((0, jsx_runtime_1.jsxs)("div", { className: "memory-snapshot", children: [(0, jsx_runtime_1.jsxs)("div", { className: "memory-snapshot__stat", children: [(0, jsx_runtime_1.jsx)("span", { className: "memory-snapshot__value", children: memoryStats.totalRecords ?? 0 }), (0, jsx_runtime_1.jsx)("span", { className: "memory-snapshot__label", children: "\u8BB0\u5F55" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "memory-snapshot__stat", children: [(0, jsx_runtime_1.jsxs)("span", { className: "memory-snapshot__value", children: [memoryStats.databaseSizeMB?.toFixed(1) ?? 0, " MB"] }), (0, jsx_runtime_1.jsx)("span", { className: "memory-snapshot__label", children: "\u5927\u5C0F" })] }), memoryStats.typeDistribution && ((0, jsx_runtime_1.jsx)("div", { className: "memory-snapshot__distribution", children: Object.entries(memoryStats.typeDistribution)
                                                            .slice(0, 4)
                                                            .map(([type, count]) => ((0, jsx_runtime_1.jsxs)("div", { className: "memory-snapshot__type", children: [(0, jsx_runtime_1.jsx)("span", { className: "memory-snapshot__type-name", children: type }), (0, jsx_runtime_1.jsx)("span", { className: "memory-snapshot__type-count", children: count })] }, type))) }))] })) : !dashboardDataLoaded ? ((0, jsx_runtime_1.jsxs)("div", { className: "skeleton skeleton--memory", children: [(0, jsx_runtime_1.jsx)("div", { className: "skeleton__line skeleton__line--w60" }), (0, jsx_runtime_1.jsx)("div", { className: "skeleton__line skeleton__line--w40" }), (0, jsx_runtime_1.jsx)("div", { className: "skeleton__line skeleton__line--w50" })] })) : ((0, jsx_runtime_1.jsx)("div", { className: "dashboard-empty", children: "\u8FDE\u63A5\u540E\u7AEF\u67E5\u770B\u8BB0\u5FC6" })) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dashboard-card", children: [(0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__header", children: (0, jsx_runtime_1.jsx)("span", { className: "dashboard-card__title", children: "\uD83D\uDCCA \u7CFB\u7EDF\u76D1\u63A7" }) }), (0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__body", children: systemResources ? ((0, jsx_runtime_1.jsxs)("div", { className: "system-monitor", children: [(0, jsx_runtime_1.jsxs)("div", { className: "system-monitor__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "system-monitor__label", children: "\u5185\u5B58" }), (0, jsx_runtime_1.jsx)("div", { className: "system-monitor__bar", children: (0, jsx_runtime_1.jsx)("div", { className: "system-monitor__bar-fill", style: {
                                                                        width: `${systemResources.memory?.usagePercent ?? 0}%`,
                                                                        backgroundColor: (systemResources.memory?.usagePercent ?? 0) > 80
                                                                            ? '#ef4444'
                                                                            : (systemResources.memory?.usagePercent ?? 0) > 60
                                                                                ? '#f59e0b'
                                                                                : '#22c55e',
                                                                    } }) }), (0, jsx_runtime_1.jsxs)("span", { className: "system-monitor__value", children: [systemResources.memory?.usagePercent?.toFixed(0) ?? 0, "%"] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "system-monitor__detail", children: ["\u5806: ", systemResources.memory?.heapUsed ?? '-', " / ", systemResources.memory?.heapTotal ?? '-', " MB"] }), systemResources.cpu?.loadAverage && ((0, jsx_runtime_1.jsxs)("div", { className: "system-monitor__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "system-monitor__label", children: "CPU" }), (0, jsx_runtime_1.jsx)("span", { className: "system-monitor__value", children: systemResources.cpu.loadAverage.map((v) => v.toFixed(2)).join(', ') })] }))] })) : healthStatus ? ((0, jsx_runtime_1.jsxs)("div", { className: "system-monitor", children: [(0, jsx_runtime_1.jsxs)("div", { className: "system-monitor__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "system-monitor__label", children: "\u72B6\u6001" }), (0, jsx_runtime_1.jsx)("span", { className: "system-monitor__value", style: { color: healthStatus.status === 'ok' ? '#22c55e' : '#f59e0b' }, children: healthStatus.status ?? 'unknown' })] }), healthStatus.uptime != null && ((0, jsx_runtime_1.jsxs)("div", { className: "system-monitor__detail", children: ["\u8FD0\u884C: ", Math.floor(healthStatus.uptime / 3600), "h", ' ', Math.floor((healthStatus.uptime % 3600) / 60), "m"] }))] })) : !dashboardDataLoaded ? ((0, jsx_runtime_1.jsxs)("div", { className: "skeleton skeleton--monitor", children: [(0, jsx_runtime_1.jsx)("div", { className: "skeleton__bar" }), (0, jsx_runtime_1.jsx)("div", { className: "skeleton__line skeleton__line--w70" }), (0, jsx_runtime_1.jsx)("div", { className: "skeleton__bar" })] })) : ((0, jsx_runtime_1.jsx)("div", { className: "dashboard-empty", children: "\u8FDE\u63A5\u540E\u7AEF\u67E5\u770B\u76D1\u63A7" })) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dashboard-card dashboard-card--compact", children: [(0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__header", children: (0, jsx_runtime_1.jsxs)("span", { className: "dashboard-card__title", children: ["\uD83D\uDD27 \u6280\u80FD (", skillList.length, ")"] }) }), (0, jsx_runtime_1.jsx)("div", { className: "dashboard-card__body", children: skillList.length > 0 ? ((0, jsx_runtime_1.jsxs)("ul", { className: "skill-list", children: [skillList.slice(0, 8).map((skill) => ((0, jsx_runtime_1.jsxs)("li", { className: "skill-list__item", title: skill.description, children: [(0, jsx_runtime_1.jsx)("span", { className: "skill-list__name", children: skill.name }), skill.category && (0, jsx_runtime_1.jsx)("span", { className: "skill-list__category", children: skill.category })] }, skill.name))), skillList.length > 8 && (0, jsx_runtime_1.jsxs)("li", { className: "skill-list__more", children: ["+", skillList.length - 8, " \u66F4\u591A"] })] })) : !dashboardDataLoaded ? ((0, jsx_runtime_1.jsx)("ul", { className: "skill-list", children: Array.from({ length: 4 }).map((_, i) => ((0, jsx_runtime_1.jsxs)("li", { className: "skill-list__item", children: [(0, jsx_runtime_1.jsx)("span", { className: "skeleton__line skeleton__line--w50" }), (0, jsx_runtime_1.jsx)("span", { className: "skeleton__line skeleton__line--w20" })] }, i))) })) : ((0, jsx_runtime_1.jsx)("div", { className: "dashboard-empty", children: "\u8FDE\u63A5\u540E\u7AEF\u67E5\u770B\u6280\u80FD" })) })] })] })) })] }), showSettings && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-overlay", onClick: () => setShowSettings(false) }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-panel", children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-title", children: "\u504F\u597D\u8BBE\u7F6E" }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-group", children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-group-title", children: "\u663E\u793A" }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u5B57\u4F53\u5927\u5C0F" }) }), (0, jsx_runtime_1.jsxs)("select", { className: "hermes-select", value: preferences.fontSize, onChange: (e) => setPreference('fontSize', Number(e.target.value)), children: [(0, jsx_runtime_1.jsx)("option", { value: 12, children: "12px" }), (0, jsx_runtime_1.jsx)("option", { value: 13, children: "13px" }), (0, jsx_runtime_1.jsx)("option", { value: 14, children: "14px" }), (0, jsx_runtime_1.jsx)("option", { value: 15, children: "15px" }), (0, jsx_runtime_1.jsx)("option", { value: 16, children: "16px" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u6D88\u606F\u5E03\u5C40" }) }), (0, jsx_runtime_1.jsxs)("select", { className: "hermes-select", value: preferences.messageLayout, onChange: (e) => setPreference('messageLayout', e.target.value), children: [(0, jsx_runtime_1.jsx)("option", { value: "compact", children: "\u7D27\u51D1" }), (0, jsx_runtime_1.jsx)("option", { value: "comfortable", children: "\u8212\u9002" }), (0, jsx_runtime_1.jsx)("option", { value: "spacious", children: "\u5BBD\u677E" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u663E\u793A\u65F6\u95F4\u6233" }) }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.showTimestamps ? 'active' : ''}`, onClick: () => setPreference('showTimestamps', !preferences.showTimestamps) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u663E\u793A\u5934\u50CF" }) }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.showAvatars ? 'active' : ''}`, onClick: () => setPreference('showAvatars', !preferences.showAvatars) })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-group", children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-group-title", children: "\u4EA4\u4E92" }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "Enter\u53D1\u9001" }), (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-desc", children: "\u5173\u95ED\u540E\u9700Ctrl+Enter\u53D1\u9001" })] }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.sendOnEnter ? 'active' : ''}`, onClick: () => setPreference('sendOnEnter', !preferences.sendOnEnter) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u81EA\u52A8\u6EDA\u52A8" }) }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.autoScroll ? 'active' : ''}`, onClick: () => setPreference('autoScroll', !preferences.autoScroll) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u58F0\u97F3\u63D0\u793A" }) }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.soundEnabled ? 'active' : ''}`, onClick: () => setPreference('soundEnabled', !preferences.soundEnabled) })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-group", children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-group-title", children: "\u901A\u77E5" }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-item", children: [(0, jsx_runtime_1.jsx)("div", { children: (0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-label", children: "\u684C\u9762\u901A\u77E5" }) }), (0, jsx_runtime_1.jsx)("div", { className: `hermes-toggle ${preferences.notificationEnabled ? 'active' : ''}`, onClick: () => setPreference('notificationEnabled', !preferences.notificationEnabled) })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hermes-settings-group", children: [(0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-group-title", children: "\u6700\u8FD1\u547D\u4EE4" }), preferences.recentCommands.length === 0 ? ((0, jsx_runtime_1.jsx)("div", { style: { color: 'var(--hermes-text-dim)', fontSize: '12px' }, children: "\u6682\u65E0\u8BB0\u5F55" })) : (preferences.recentCommands.slice(0, 8).map((cmd, i) => ((0, jsx_runtime_1.jsx)("div", { className: "hermes-settings-item", children: (0, jsx_runtime_1.jsx)("span", { className: "hermes-settings-label", style: { fontSize: '12px', fontFamily: 'monospace' }, children: cmd }) }, i))))] })] })] }))] }));
};
exports.DesktopDashboard = DesktopDashboard;
async function simulateAIResponse(input) {
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
function formatMessage(content) {
    const codeBlockRegex = /```([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    let keyIndex = 0;
    while ((match = codeBlockRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
            parts.push(...formatInlineContent(content.slice(lastIndex, match.index), keyIndex));
            keyIndex += 10;
        }
        const codeContent = match[1].trim();
        parts.push((0, jsx_runtime_1.jsx)("pre", { className: "message-code-block", children: (0, jsx_runtime_1.jsx)("code", { children: codeContent }) }, `code-${keyIndex++}`));
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < content.length) {
        parts.push(...formatInlineContent(content.slice(lastIndex), keyIndex));
    }
    return parts;
}
function formatInlineContent(text, baseKey) {
    const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/g);
    return parts.map((part, index) => {
        const key = `inline-${baseKey}-${index}`;
        if (part.startsWith('**') && part.endsWith('**')) {
            return (0, jsx_runtime_1.jsx)("strong", { children: part.slice(2, -2) }, key);
        }
        if (part.startsWith('`') && part.endsWith('`')) {
            return ((0, jsx_runtime_1.jsx)("code", { className: "message-inline-code", children: part.slice(1, -1) }, key));
        }
        const lines = part.split('\n');
        return lines.map((line, i) => ((0, jsx_runtime_1.jsxs)(react_1.default.Fragment, { children: [i > 0 && (0, jsx_runtime_1.jsx)("br", {}), line] }, `${key}-${i}`)));
    });
}
function formatTime(date) {
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}
exports.default = exports.DesktopDashboard;
