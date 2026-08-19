/**
 * @jest-environment jsdom
 *
 * 聊天渲染契约测试（真实断言，覆盖"双重回复"盲区）
 *
 * 背景：曾出现"对单条消息返回两段不同问候"的双重回复。
 * 之前的修复把去重逻辑（ensureAssistantMessage）落在 ChatInterface 上，
 * 但 ChatInterface 当前并未被 App 挂载——App 的 chat 视图实际渲染的是
 * DesktopDashboard，而 DesktopDashboard 走 HTTP（apiService.processMessage），
 * 不订阅 connectionManager 的流式事件。
 *
 * 因此本测试直接针对【真实活路径】DesktopDashboard：
 * 渲染真实 <DesktopDashboard />，模拟用户输入并点击发送，
 * 断言"一次发送只新增恰好一条助手气泡"，且回复文本完整出现一次。
 *
 * 若有人回退成"既走 HTTP 又订阅 WS 流式各渲染一次"之类的双路径，
 * 或出现一次发送被 dispatch 两次 ADD_MESSAGE，气泡数会变成 +2，
 * 该测试即失败——这就是防线。
 *
 * 注：基于已验证可运行的 DesktopDashboard.test.tsx 的 mock 模式。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { apiService } from '../../api/apiService';
import { DesktopDashboard } from './DesktopDashboard';

const mockShowInfo = jest.fn();
const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
const mockShowWarning = jest.fn();
const mockAddRecentCommand = jest.fn();
const mockSetPreference = jest.fn();
const mockFetchBudgetStatus = jest.fn();
const mockOnNavigate = jest.fn();

jest.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

jest.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: jest.fn(),
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showWarning: mockShowWarning,
    showInfo: mockShowInfo,
    dismissToast: jest.fn(),
    clearAll: jest.fn(),
  }),
}));

jest.mock('../../hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({
    preferences: {
      fontSize: 14,
      messageLayout: 'comfortable',
      showTimestamps: true,
      showAvatars: true,
      sendOnEnter: true,
      soundEnabled: false,
      notificationEnabled: true,
      autoScroll: true,
      maxMessages: 500,
      sidebarCollapsed: false,
      recentCommands: [],
      pinnedShortcuts: [],
      lastWorkspace: '',
      dashboardGreeting: '',
    },
    setPreference: mockSetPreference,
    setPreferences: jest.fn(),
    resetPreferences: jest.fn(),
    addRecentCommand: mockAddRecentCommand,
    clearRecentCommands: jest.fn(),
  }),
}));

const mockAgentState = { executionUpdates: [], toolTraces: [] };
const mockBudgetState = {
  tokenUsed: 1000,
  tokenBudget: 500000,
  costUsed: 0.12,
  costBudget: 10,
  fetchBudgetStatus: mockFetchBudgetStatus,
};

jest.mock('../../stores/useAgentStore', () => ({
  useAgentStore: (selector: any) => (selector ? selector(mockAgentState) : mockAgentState),
}));

jest.mock('../../stores/useBudgetStore', () => ({
  useBudgetStore: (selector: any) => (selector ? selector(mockBudgetState) : mockBudgetState),
}));

jest.mock('../../stores/useWorkspaceStore', () => ({
  useWorkspaceStore: (selector: any) => {
    const mockState = { activeSessionId: 'test-session-123', sessions: [], loading: false };
    return selector ? selector(mockState) : mockState;
  },
}));

jest.mock('../../api/apiService', () => ({
  apiService: {
    processMessage: jest.fn(),
    getSystemResources: jest.fn().mockResolvedValue({
      success: true,
      data: { memory: { usagePercent: 42 }, disk: { used: 120, total: 500 } },
    }),
    getHealth: jest.fn().mockResolvedValue({
      success: true,
      data: { status: 'ok', model: 'v5', uptime: 3600 },
    }),
    getBudgetStatus: jest.fn().mockResolvedValue({
      success: true,
      data: { tokenUsed: 1000, tokenBudget: 500000, costUsed: 0.12, costBudget: 10, period: 'daily' },
    }),
    getGatewayStatus: jest.fn().mockResolvedValue({
      success: true,
      data: { status: 'partial', platforms: [] },
    }),
    getMemoryStats: jest.fn().mockResolvedValue({
      success: true,
      data: { totalRecords: 128, databaseSizeMB: 2.5, typeDistribution: { text: 100 } },
    }),
    searchMemory: jest.fn().mockResolvedValue({ success: true, data: { results: [] } }),
    getAutomationTasks: jest.fn().mockResolvedValue({ success: true, data: { tasks: [] } }),
    toggleAutomationTask: jest.fn().mockResolvedValue({ success: true }),
    executeAutomationTask: jest.fn().mockResolvedValue({ success: true }),
    osvScan: jest.fn().mockResolvedValue({ success: true, data: { critical: 0, high: 0, medium: 0, low: 0, report: '' } }),
    diskCleanup: jest.fn().mockResolvedValue({ success: true, data: { totalItems: 0, totalSize: 0, report: '', executed: false } }),
    subdirectoryHints: jest.fn().mockResolvedValue({ success: true, data: { totalDirs: 3, hints: 'src/\npython/\n' } }),
  },
}));

const setIntervalSpy = jest.spyOn(window, 'setInterval').mockImplementation((() => 123) as any);

async function renderDashboard() {
  let result;
  await act(async () => {
    result = render(<DesktopDashboard onNavigate={mockOnNavigate} />);
  });
  // 等待挂载副作用（记忆统计等）执行完毕
  await waitFor(() => expect(apiService.getMemoryStats).toHaveBeenCalled());
  return result;
}

/** 统计"助手气泡"数量（排除正在输入的 typing 指示气泡） */
function countAssistantBubbles(): number {
  return document.querySelectorAll('.hermes-message-assistant:not(.hermes-message-typing)').length;
}

/** 统计含指定文本的助手气泡数量 */
function bubbleCountWithText(text: string): number {
  return Array.from(
    document.querySelectorAll('.hermes-message-assistant:not(.hermes-message-typing) .message-text')
  ).filter((el) => (el.textContent ?? '').includes(text)).length;
}

async function sendMessage(text: string, replyText: string): Promise<void> {
  const { apiService: svc } = require('../../api/apiService');
  jest.spyOn(svc, 'processMessage').mockResolvedValue({
    success: true,
    data: { response: replyText, traceId: 'trace-x', intent: 'chat' },
  } as any);

  const input = screen.getByPlaceholderText('输入消息... (Enter发送, Shift+Enter换行)');
  fireEvent.change(input, { target: { value: text } });

  const sendButton = document.querySelector('.hermes-send-btn');
  if (!sendButton) throw new Error('未找到发送按钮 .hermes-send-btn');
  fireEvent.click(sendButton);

  await waitFor(() => {
    expect(screen.getByText(replyText)).toBeInTheDocument();
  });
}

describe('聊天渲染契约：一次发送只新增恰好一条助手气泡（无双回复）', () => {
  beforeEach(() => {
    localStorage.clear();
    setIntervalSpy.mockClear();
    mockShowInfo.mockClear();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowWarning.mockClear();
    mockAddRecentCommand.mockClear();
    mockSetPreference.mockClear();
    mockFetchBudgetStatus.mockClear();
    mockOnNavigate.mockClear();
  });

  afterAll(() => {
    setIntervalSpy.mockRestore();
  });

  it('发送一条消息：助手气泡数 = 基线 + 1，且回复文本只出现一次', async () => {
    await renderDashboard();

    // 基线：欢迎消息含 1 条助手气泡
    const baseline = countAssistantBubbles();
    expect(baseline).toBeGreaterThanOrEqual(1);

    await sendMessage('你好', '契约测试回复-A');

    // 关键断言：一次发送只新增恰好一条助手气泡（双回复会变成 +2）
    expect(countAssistantBubbles()).toBe(baseline + 1);
    // 回复文本恰好落在一条气泡内
    expect(bubbleCountWithText('契约测试回复-A')).toBe(1);
  });

  it('连续发送两条消息：每条各新增一条助手气泡（无跨条叠加）', async () => {
    await renderDashboard();

    const baseline = countAssistantBubbles();

    await sendMessage('你好', '契约测试回复-A');
    await sendMessage('再见', '契约测试回复-B');

    // 两条消息应各产生一条气泡：基线 + 2
    expect(countAssistantBubbles()).toBe(baseline + 2);
    expect(bubbleCountWithText('契约测试回复-A')).toBe(1);
    expect(bubbleCountWithText('契约测试回复-B')).toBe(1);
  });

  it('后端失败时走回退：仍只新增一条助手气泡', async () => {
    await renderDashboard();

    const baseline = countAssistantBubbles();

    // 让 processMessage 返回 success:false，触发 simulateAIResponse 回退分支
    const { apiService: svc } = require('../../api/apiService');
    jest.spyOn(svc, 'processMessage').mockResolvedValue({
      success: false,
      data: null,
    } as any);

    const input = screen.getByPlaceholderText('输入消息... (Enter发送, Shift+Enter换行)');
    fireEvent.change(input, { target: { value: '你好' } });
    const sendButton = document.querySelector('.hermes-send-btn');
    if (!sendButton) throw new Error('未找到发送按钮 .hermes-send-btn');
    fireEvent.click(sendButton);

    // 回退路径（simulateAIResponse）有 800~2000ms 人为延迟，放宽超时
    await waitFor(
      () => {
        expect(countAssistantBubbles()).toBe(baseline + 1);
      },
      { timeout: 5000 }
    );
  });
});
