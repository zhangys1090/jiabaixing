/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { apiService } from '../../api/apiService';
import { DesktopDashboard } from './DesktopDashboard';
import { FEATURE_NODES } from './FeatureNodeGrid';

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
  useAgentStore: (selector: any) =>
    selector ? selector(mockAgentState) : mockAgentState,
}));

jest.mock('../../stores/useBudgetStore', () => ({
  useBudgetStore: (selector: any) =>
    selector ? selector(mockBudgetState) : mockBudgetState,
}));

jest.mock('../../stores/useWorkspaceStore', () => ({
  useWorkspaceStore: (selector: any) => {
    const mockState = {
      activeSessionId: 'test-session-123',
      sessions: [],
      loading: false,
    };
    return selector ? selector(mockState) : mockState;
  },
}));

jest.mock('../../api/apiService', () => ({
  apiService: {
    processMessage: jest.fn().mockResolvedValue({
      success: true,
      data: { response: '这是来自后端的响应', traceId: 't1', intent: 'chat' },
    }),
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
    getAutomationTasks: jest.fn().mockResolvedValue({
      success: true,
      data: {
        tasks: [
          {
            id: 't1',
            name: '每日日报',
            schedule: '0 9 * * *',
            enabled: true,
            executionCount: 10,
            successCount: 9,
          },
        ],
      },
    }),
    toggleAutomationTask: jest.fn().mockResolvedValue({ success: true }),
    executeAutomationTask: jest.fn().mockResolvedValue({ success: true }),
    osvScan: jest.fn().mockResolvedValue({ success: true, data: { critical: 0, high: 0, medium: 0, low: 0, report: '' } }),
    diskCleanup: jest.fn().mockResolvedValue({
      success: true,
      data: { totalItems: 0, totalSize: 0, report: '', executed: false },
    }),
    subdirectoryHints: jest.fn().mockResolvedValue({
      success: true,
      data: { totalDirs: 3, hints: 'src/\npython/\n' },
    }),
  },
}));

const setIntervalSpy = jest.spyOn(window, 'setInterval').mockImplementation((() => 123) as any);

async function renderDashboard() {
  let result;
  await act(async () => {
    result = render(<DesktopDashboard onNavigate={mockOnNavigate} />);
  });
  await waitFor(() => expect(apiService.getMemoryStats).toHaveBeenCalled());
  return result;
}

describe('DesktopDashboard', () => {
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

  test('renders welcome messages and agent stamp bar', async () => {
    await renderDashboard();

    expect(screen.getByText('欢迎使用家百星智能助手系统 V5.0')).toBeInTheDocument();
    expect(screen.getByText(/我是您的AI助手/)).toBeInTheDocument();
    // Agent 印记条默认可见
    expect(screen.getByText('等待同行指令')).toBeInTheDocument();
    expect(screen.getByText('⚡ 就绪')).toBeInTheDocument();
  });

  test('right sidebar expands on click to show info cards', async () => {
    await renderDashboard();

    // 右侧面板默认折叠，只显示展开按钮
    const expandBtn = screen.getByTitle('展开信息面板');
    expect(expandBtn).toBeInTheDocument();
    fireEvent.click(expandBtn);

    await waitFor(() => {
      expect(screen.getByText('⚡ 快速能力')).toBeInTheDocument();
      expect(screen.getByText('🤖 Agent 动态')).toBeInTheDocument();
      expect(screen.getByText('🧠 记忆快照')).toBeInTheDocument();
    });
  });

  test('renders quick feature nodes after sidebar expands', async () => {
    await renderDashboard();

    // 先展开右侧面板
    const expandBtn = screen.getByTitle('展开信息面板');
    fireEvent.click(expandBtn);

    await waitFor(() => {
      FEATURE_NODES.slice(0, 6).forEach((node) => {
        expect(screen.getByText(node.label)).toBeInTheDocument();
      });
    });
  });

  test('clicking a feature node shows toast and updates input', async () => {
    await renderDashboard();

    // 先展开右侧面板
    const expandBtn = screen.getByTitle('展开信息面板');
    fireEvent.click(expandBtn);

    let clarifyCard: HTMLElement | null = null;
    await waitFor(() => {
      clarifyCard = screen.getByRole('button', {
        name: `${FEATURE_NODES[0].label}: ${FEATURE_NODES[0].description}`,
      });
    });
    fireEvent.click(clarifyCard!);

    expect(mockShowInfo).toHaveBeenCalledWith('已选择 澄清工具');
    const input = screen.getByPlaceholderText('输入消息... (Enter发送, Shift+Enter换行)');
    expect(input).toHaveValue('请帮我澄清并确认这个需求边界：');
  });

  test('sends a message and displays backend response', async () => {
    const { apiService } = require('../../api/apiService');
    jest.spyOn(apiService, 'processMessage').mockResolvedValue({
      success: true,
      data: { response: '这是来自后端的响应', traceId: 't1', intent: 'chat' },
    } as any);

    await renderDashboard();

    const input = screen.getByPlaceholderText('输入消息... (Enter发送, Shift+Enter换行)');
    fireEvent.change(input, { target: { value: '你好' } });

    const sendButton = document.querySelector('.hermes-send-btn');
    expect(sendButton).toBeTruthy();
    fireEvent.click(sendButton!);

    await waitFor(() => {
      expect(screen.getByText('你好')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('这是来自后端的响应')).toBeInTheDocument();
    });
  });

  test('opens and closes settings panel', async () => {
    await renderDashboard();

    // 点击左侧 + 号打开快捷工具菜单
    const toolsBtn = screen.getByTitle('快捷工具');
    fireEvent.click(toolsBtn);

    // 点击偏好设置
    const settingsItem = screen.getByText('偏好设置');
    fireEvent.click(settingsItem);

    expect(screen.getByText('偏好设置')).toBeInTheDocument();
    expect(screen.getByText('字体大小')).toBeInTheDocument();

    const overlay = document.querySelector('.hermes-settings-overlay');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay!);

    await waitFor(() => {
      expect(screen.queryByText('偏好设置')).not.toBeInTheDocument();
    });
  });

  test('clicking shortcut navigates to corresponding view', async () => {
    await renderDashboard();

    // 点击左侧 + 号打开快捷工具菜单
    const toolsBtn = screen.getByTitle('快捷工具');
    fireEvent.click(toolsBtn);

    // 点击自动化
    const automationItem = screen.getByText('自动化');
    fireEvent.click(automationItem);

    expect(mockOnNavigate).toHaveBeenCalledWith('automation');
  });

  test('loads memory stats on mount', async () => {
    await renderDashboard();

    // 验证记忆统计被加载
    expect(apiService.getMemoryStats).toHaveBeenCalled();

    // 展开右侧面板查看记忆卡片
    const expandBtn = screen.getByTitle('展开信息面板');
    fireEvent.click(expandBtn);

    await waitFor(() => {
      expect(screen.getByText('🧠 记忆快照')).toBeInTheDocument();
    });
  });
});
