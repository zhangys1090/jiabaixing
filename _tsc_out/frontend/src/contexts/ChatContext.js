"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatProvider = void 0;
exports.useChat = useChat;
exports.useChatState = useChatState;
exports.useChatDispatch = useChatDispatch;
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * ChatContext - 聊天状态管理
 * 提取 ChatInterface 中的共享状态，使用 Context + useReducer 模式
 * 消除 props drilling，支持复合组件架构
 */
const react_1 = require("react");
const apiService_1 = require("../api/apiService");
// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════
const STORAGE_KEY = 'jiabaixing_chat_messages';
const MAX_MESSAGES = 100;
const INITIAL_AGENT_STEPS = [
    { name: 'perceive', label: '感知阶段', status: 'pending' },
    { name: 'plan', label: '规划阶段', status: 'pending' },
    { name: 'execute', label: '执行阶段', status: 'pending' },
    { name: 'verify', label: '校验阶段', status: 'pending' },
    { name: 'output', label: '输出阶段', status: 'pending' },
    { name: 'learn', label: '学习阶段', status: 'pending' },
];
// ═══════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════
function chatReducer(state, action) {
    switch (action.type) {
        case 'SET_MESSAGES':
            return { ...state, messages: action.payload };
        case 'ADD_MESSAGE':
            return {
                ...state,
                messages: [...state.messages, action.payload].slice(-MAX_MESSAGES),
            };
        case 'UPDATE_MESSAGE':
            return {
                ...state,
                messages: state.messages.map((m) => (m.id === action.id ? { ...m, ...action.updates } : m)),
            };
        case 'SET_INPUT_TEXT':
            return { ...state, inputText: action.payload };
        case 'SET_IS_LOADING':
            return { ...state, isLoading: action.payload };
        case 'SET_IS_TYPING':
            return { ...state, isTyping: action.payload };
        case 'SET_IS_RUNNING':
            return { ...state, isRunning: action.payload };
        case 'TOGGLE_LOG_PANEL':
            return { ...state, logPanelVisible: !state.logPanelVisible };
        case 'TOGGLE_TTS':
            return { ...state, ttsEnabled: !state.ttsEnabled };
        case 'ADD_SERVER_LOG':
            return {
                ...state,
                serverLogs: [...state.serverLogs, action.payload].slice(-200),
            };
        case 'UPDATE_AGENT_STEP':
            return {
                ...state,
                agentSteps: state.agentSteps.map((s) => (s.name === action.name ? { ...s, status: action.status } : s)),
            };
        case 'RESET_AGENT_STEPS':
            return {
                ...state,
                agentSteps: INITIAL_AGENT_STEPS.map((s) => ({ ...s })),
            };
        case 'CLEAR_MESSAGES':
            return {
                ...state,
                messages: [
                    {
                        id: 'msg_init_welcome',
                        content: '我在。有什么可以帮你的？',
                        sender: 'assistant',
                        timestamp: new Date(),
                        status: 'sent',
                        emoji: '👋',
                    },
                ],
            };
        case 'PREPEND_MESSAGES':
            const existingIds = new Set(state.messages.map((m) => m.id));
            const newMessages = action.payload.filter((m) => !existingIds.has(m.id));
            return {
                ...state,
                messages: [...newMessages, ...state.messages].slice(-MAX_MESSAGES),
            };
        case 'ADD_BRAIN_STAGE_UPDATE':
            return {
                ...state,
                brainStageUpdates: [...state.brainStageUpdates, action.payload].slice(-50),
            };
        case 'ADD_PERCEPTION_UPDATE':
            return {
                ...state,
                perceptionUpdates: [...state.perceptionUpdates, action.payload].slice(-50),
            };
        case 'ADD_SKILL_EXECUTION_UPDATE':
            return {
                ...state,
                skillExecutionUpdates: [...state.skillExecutionUpdates, action.payload].slice(-50),
            };
        case 'ADD_EVOLUTION_EVENT':
            return {
                ...state,
                evolutionEvents: [...state.evolutionEvents, action.payload].slice(-50),
            };
        case 'CLEAR_EXECUTION_UPDATES':
            return {
                ...state,
                brainStageUpdates: [],
                perceptionUpdates: [],
                skillExecutionUpdates: [],
            };
        case 'MARK_SENDING_AS_SENT':
            return {
                ...state,
                messages: state.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'sent' } : m)),
            };
        case 'CLEAR_PROGRESS_MESSAGES':
            return {
                ...state,
                messages: state.messages.filter((m) => m.status !== 'progress'),
            };
        case 'SET_CURRENT_TRACE_ID':
            return {
                ...state,
                currentTraceId: action.payload,
            };
        case 'APPEND_STREAM_CHUNK':
            return {
                ...state,
                messages: state.messages.map((m) => (m.id === action.id ? { ...m, content: m.content + action.chunk } : m)),
            };
        case 'FINISH_STREAM':
            return {
                ...state,
                messages: state.messages.map((m) => (m.id === action.id ? { ...m, status: 'sent' } : m)),
                isTyping: false,
            };
        case 'ADD_TOOL_EVENT':
            return {
                ...state,
                messages: state.messages.map((m) => m.id === action.id
                    ? { ...m, toolEvents: [...(m.toolEvents || []), action.payload] }
                    : m),
            };
        case 'UPDATE_TOOL_EVENT':
            return {
                ...state,
                messages: state.messages.map((m) => {
                    if (m.id !== action.id || !m.toolEvents)
                        return m;
                    // 从末尾找到匹配 toolName 的最后一个事件并更新
                    const events = [...m.toolEvents];
                    for (let i = events.length - 1; i >= 0; i--) {
                        if (events[i].toolName === action.toolName) {
                            events[i] = { ...events[i], ...action.updates };
                            break;
                        }
                    }
                    return { ...m, toolEvents: events };
                }),
            };
        default:
            return state;
    }
}
// ═══════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════
const ChatContext = (0, react_1.createContext)(null);
// ═══════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════
const ChatProvider = ({ children }) => {
    const messageCounterRef = (0, react_1.useRef)(0);
    const historyLoadedRef = (0, react_1.useRef)(false);
    const loadPersistedMessages = () => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                const cleaned = parsed.filter((m) => {
                    if (m.status === 'error')
                        return false;
                    if (m.content &&
                        typeof m.content === 'string' &&
                        (m.content.includes('执行失败') || m.content.includes('参数验证失败')))
                        return false;
                    return true;
                });
                return cleaned.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
            }
        }
        catch {
            // noop
        }
        return [];
    };
    const convertConversationToMessages = (conversations) => {
        const messages = [];
        let msgIndex = 0;
        for (const conv of conversations) {
            try {
                const content = typeof conv.content === 'string' ? JSON.parse(conv.content) : conv.content;
                if (content.user_input) {
                    messages.push({
                        id: `history_user_${conv.id}_${msgIndex}`,
                        content: content.user_input,
                        sender: 'user',
                        timestamp: new Date(conv.timestamp),
                        status: 'sent',
                    });
                    msgIndex++;
                }
                if (content.response || content.ai_response) {
                    const responseText = content.response || content.ai_response;
                    messages.push({
                        id: `history_ai_${conv.id}_${msgIndex}`,
                        content: responseText,
                        sender: 'assistant',
                        timestamp: new Date(conv.timestamp),
                        status: 'sent',
                    });
                    msgIndex++;
                }
            }
            catch {
                // noop
            }
        }
        return messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    };
    const persisted = loadPersistedMessages();
    const initialMessages = persisted.length > 0
        ? persisted
        : [
            {
                id: 'msg_init_welcome',
                content: '我在。有什么可以帮你的？',
                sender: 'assistant',
                timestamp: new Date(),
                status: 'sent',
                emoji: '👋',
            },
        ];
    const [state, dispatch] = (0, react_1.useReducer)(chatReducer, {
        messages: initialMessages,
        inputText: '',
        isLoading: false,
        isTyping: false,
        isRunning: false,
        logPanelVisible: false,
        ttsEnabled: true,
        serverLogs: [],
        agentSteps: INITIAL_AGENT_STEPS.map((s) => ({ ...s })),
        brainStageUpdates: [],
        perceptionUpdates: [],
        skillExecutionUpdates: [],
        evolutionEvents: [],
        currentTraceId: null,
    });
    (0, react_1.useEffect)(() => {
        if (historyLoadedRef.current)
            return;
        historyLoadedRef.current = true;
        const loadHistoryFromBackend = async () => {
            try {
                const response = await apiService_1.apiService.getConversations(50);
                if (response.success && response.data) {
                    const conversations = response.data;
                    const historyMessages = convertConversationToMessages(conversations);
                    if (historyMessages.length > 0) {
                        dispatch({ type: 'PREPEND_MESSAGES', payload: historyMessages });
                    }
                }
            }
            catch {
                // noop
            }
        };
        loadHistoryFromBackend();
    }, []);
    // 注意：助手消息的渲染已统一收敛到 ChatInterface（通过 useWebSocket 订阅
    // connectionManager 的 response_ready / stream_* 事件），此处不再重复订阅，
    // 避免同一事件被渲染两次（双重回复）。ChatContext 仅持有共享状态。
    // 持久化消息
    (0, react_1.useEffect)(() => {
        try {
            const toStore = state.messages
                .filter((m) => m.status !== 'sending' && m.status !== 'thinking' && m.status !== 'typing')
                .slice(-MAX_MESSAGES)
                .map((m) => ({ ...m, timestamp: m.timestamp.toISOString() }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
        }
        catch {
            // noop
        }
    }, [state.messages]);
    const generateMessageId = (0, react_1.useCallback)(() => {
        messageCounterRef.current += 1;
        return `msg_${Date.now().toString(36)}_${messageCounterRef.current.toString(36)}`;
    }, []);
    return (0, jsx_runtime_1.jsx)(ChatContext.Provider, { value: { state, dispatch, generateMessageId }, children: children });
};
exports.ChatProvider = ChatProvider;
// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════
function useChat() {
    const context = (0, react_1.useContext)(ChatContext);
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider');
    }
    return context;
}
function useChatState() {
    return useChat().state;
}
function useChatDispatch() {
    return useChat().dispatch;
}
