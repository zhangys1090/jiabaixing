"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * @jest-environment jsdom
 */
const react_1 = require("@testing-library/react");
const App_1 = __importDefault(require("./App"));
const mockFetch = jest.fn((url) => {
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
global.fetch = mockFetch;
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
    useAgentStore: (selector) => {
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
    useWorkspaceStore: (selector) => {
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
        (0, react_1.render)((0, jsx_runtime_1.jsx)(App_1.default, {}));
        const appElement = react_1.screen.getByText('欢迎使用家百星智能助手系统 V5.0');
        expect(appElement).toBeInTheDocument();
    });
    test('renders sidebar with settings navigation', () => {
        (0, react_1.render)((0, jsx_runtime_1.jsx)(App_1.default, {}));
        const settingsNav = react_1.screen.getByTestId('nav-settings');
        expect(settingsNav).toBeInTheDocument();
        expect(settingsNav).toHaveTextContent('偏好设置');
    });
    test('should switch to settings view', async () => {
        (0, react_1.render)((0, jsx_runtime_1.jsx)(App_1.default, {}));
        const settingsNav = react_1.screen.getByTestId('nav-settings');
        react_1.fireEvent.click(settingsNav);
        await (0, react_1.waitFor)(() => {
            expect(react_1.screen.getByText('偏好设置')).toBeInTheDocument();
        });
    });
});
