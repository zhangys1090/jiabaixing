/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

const mockFetch = jest.fn((url: string) => {
  if (url.includes('/api/budget/status')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ tokenUsed: 0, tokenBudget: 500000, costUsed: 0, costBudget: 10, period: 'daily' }),
    });
  }
  if (url.includes('/api/integration/platforms')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ platforms: [] }),
    });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve([]),
  });
});

global.fetch = mockFetch as unknown as typeof global.fetch;

jest.mock('./utils/errorMonitoring', () => ({
  errorMonitor: {
    initialize: jest.fn(),
    reportNetworkError: jest.fn(),
    reportCustomError: jest.fn(),
  },
}));

jest.mock('./hooks/websocket', () => ({
  connectionManager: {
    onAgentExecution: jest.fn(),
    offAgentExecution: jest.fn(),
    onBrainStageUpdate: jest.fn(),
    offBrainStageUpdate: jest.fn(),
    onToolTrace: jest.fn(),
    offToolTrace: jest.fn(),
  },
}));

jest.mock('./stores/useAgentStore', () => ({
  useAgentStore: (selector: any) => {
    const state = {
      executionUpdates: [],
      brainStageUpdates: [],
      toolTraces: [],
      clarificationRequest: null,
      executionPreview: null,
      fileEvents: [],
      crossSessionTasks: [],
      fcLoopCount: 0,
      fcLoopMax: 8,
      tokenBudget: 6000,
      tokenUsed: 0,
      harnessStatus: null,
      loading: false,
      error: null,
      addExecutionUpdate: jest.fn(),
      addBrainStageUpdate: jest.fn(),
      addToolTrace: jest.fn(),
      setClarificationRequest: jest.fn(),
      setExecutionPreview: jest.fn(),
      addFileEvent: jest.fn(),
      setCrossSessionTasks: jest.fn(),
      updateFcLoop: jest.fn(),
      fetchHarnessStatus: jest.fn(),
      reset: jest.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

jest.mock('./stores/useWorkspaceStore', () => ({
  useWorkspaceStore: (selector: any) => {
    const state = {
      sessions: [],
      activeSessionId: null,
      fetchSessions: jest.fn(),
      setActiveSession: jest.fn(),
      createSession: jest.fn(),
      renameSession: jest.fn(),
      deleteSession: jest.fn(),
      reorderSessions: jest.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders App component', () => {
    render(<App />);
    const appElement = screen.getByText('欢迎使用家百星智能助手系统 V5.0');
    expect(appElement).toBeInTheDocument();
  });

  test('renders sidebar with settings navigation', () => {
    render(<App />);
    const settingsNav = screen.getByTestId('nav-settings');
    expect(settingsNav).toBeInTheDocument();
    expect(settingsNav).toHaveTextContent('偏好设置');
  });

  test('should switch to settings view', async () => {
    render(<App />);

    const settingsNav = screen.getByTestId('nav-settings');
    fireEvent.click(settingsNav);

    await waitFor(() => {
      expect(screen.getByText('偏好设置')).toBeInTheDocument();
    });
  });
});
