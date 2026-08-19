"use strict";
/**
 * 前后端共享契约层
 *
 * 本文件是前后端唯一的"真相来源"(Single Source of Truth)。
 * 所有 API 端点、WebSocket 事件、请求/响应数据模型均在此定义。
 * 后端路由和前端 API 服务层必须引用此文件，禁止硬编码。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENTBUS_TO_WS_MAP = exports.WS_EVENTS = exports.SYSTEM_CONSTANTS = exports.API_ENDPOINTS = void 0;
// ====================== API 端点契约 ======================
exports.API_ENDPOINTS = {
    HEALTH: '/api/health',
    MODELS: '/api/models',
    MODELS_STATUS: '/api/models/status',
    MODELS_HEALTH: '/api/models/health',
    MODELS_SWITCH: '/api/models/switch',
    PROCESS: '/api/process',
    CORRECT: '/api/correct',
    LOGS_SSE: '/api/logs',
    LOGS_QUERY: '/api/logs',
    LOGS_ERRORS: '/api/logs/errors',
    EVOLUTION: '/api/evolution',
    EVOLUTION_STATUS: '/api/evolution/status',
    EVOLUTION_METRICS: '/api/evolution/metrics',
    EVOLUTION_INSIGHTS: '/api/evolution/insights',
    EVOLUTION_TRIGGER: '/api/evolution/trigger',
    EVOLUTION_CYCLE: '/api/evolution/cycle',
    EVOLUTION_HEALING: '/api/evolution/healing',
    EVOLUTION_REFACTOR: '/api/evolution/refactor',
    EVOLUTION_ENHANCE: '/api/evolution/enhance',
    ORCHESTRATOR_METRICS: '/api/orchestrator/metrics',
    ORCHESTRATOR_OPTIMIZE: '/api/orchestrator/optimize',
    MEMORY_STORE: '/api/memory/store',
    MEMORY_SEARCH: '/api/memory/search',
    MEMORY_PROFILE: '/api/memory/profile',
    MEMORY_PREFERENCES: '/api/memory/preferences',
    MEMORY_STATS: '/api/memory/stats',
    SECURITY_LOGS: '/api/security/logs',
    SECURITY_EVENTS: '/api/security/events',
    SECURITY_REPORT: '/api/security/report',
    SECURITY_VALIDATE: '/api/security/validate',
    SECURITY_AUDIT: '/api/security/audit',
    SKILLS_EXECUTE: '/api/skills/execute',
    SKILLS_LIST: '/api/skills/list',
    PERFORMANCE_SNAPSHOT: '/api/performance/snapshot',
    PERFORMANCE_METRICS: '/api/performance/metrics',
    PERFORMANCE_ERRORS: '/api/performance/errors',
    LLM_PERFORMANCE: '/api/llm/performance',
    SYSTEM_RESOURCES: '/api/system/resources',
    SYSTEM_INTEGRITY: '/api/system/integrity',
    SYSTEM_METRICS: '/api/metrics',
    SYSTEM_CONFIG: '/api/config',
    SYSTEM_OSV_SCAN: '/api/system/osv-scan',
    SYSTEM_DISK_CLEANUP: '/api/system/disk-cleanup',
    SYSTEM_SUBDIRECTORY_HINTS: '/api/system/subdirectory-hints',
    AUTOMATION_TASKS: '/api/automation/tasks',
    AUTOMATION_TRIGGERS: '/api/automation/triggers',
    AUTOMATION_PATTERNS: '/api/automation/patterns',
    TASKS_CREATE: '/api/tasks/create',
    TASKS_LIST: '/api/tasks/list',
    TASKS_CANCEL: '/api/tasks/:id/cancel',
    TASKS_PAUSE: '/api/tasks/:id/pause',
    TASKS_RESUME: '/api/tasks/:id/resume',
    TASKS_HARNESS_STATUS: '/api/tasks/harness/status',
    INTEGRATION: '/api/integration',
    INTEGRATION_PLATFORMS: '/api/integration/platforms',
    INTEGRATION_CONNECT: '/api/integration/:platform/connect',
    INTEGRATION_DISCONNECT: '/api/integration/:platform/disconnect',
    INTEGRATION_STATUS: '/api/integration/:platform/status',
    INTEGRATION_WEBHOOK: '/api/integration/:platform/webhook',
    INTEGRATION_SEND: '/api/integration/:platform/send',
    SIMULATE_TASK: '/api/simulate_task',
    CONVERSATIONS: '/api/conversations',
    USER_BEHAVIOR_EVENTS: '/api/user-behavior/events',
    RECOMMENDATIONS: '/api/recommendations',
    PERFORMANCE_METRICS_POST: '/api/performance/metrics',
    ERROR_MONITORING: '/api/error/monitoring',
    OPTIMIZATION_PROCESS: '/api/optimization/process',
    OPTIMIZATION_HISTORY: '/api/optimization/history',
    // Desktop
    DESKTOP_SCREENSHOT: '/api/desktop/screenshot',
    DESKTOP_AUTOMATE: '/api/desktop/automate',
    // MCP
    MCP_SERVERS: '/api/mcp/servers',
    MCP_SERVER_DETAIL: '/api/mcp/servers/:name',
    MCP_SERVER_START: '/api/mcp/servers/:name/start',
    MCP_SERVER_STOP: '/api/mcp/servers/:name/stop',
    MCP_SERVERS_START_ALL: '/api/mcp/servers/start-all',
    MCP_SERVER_TOOLS: '/api/mcp/servers/:name/tools',
    MCP_SERVER_CALL: '/api/mcp/servers/:name/call',
    MCP_SERVER_MESSAGE: '/api/mcp/servers/:name/message',
    MCP_REGISTER: '/api/mcp/register',
    // TRAE
    TRAE_HEALTH: '/api/trae/health',
    TRAE_PERFORMANCE: '/api/trae/performance',
    TRAE_MCP_STATUS: '/api/trae/mcp/status',
    TRAE_SKILLS_STATUS: '/api/trae/skills/status',
    TRAE_SKILLS_EXECUTE: '/api/trae/skills/execute',
    TRAE_SECURITY_AUDIT: '/api/trae/security/audit',
    TRAE_TESTING_GENERATE: '/api/trae/testing/generate',
    // Debug
    DEBUG_WEIGHTS: '/api/debug/weights',
    DEBUG_RECENT_HISTORY: '/api/debug/recentHistory',
    DEBUG_TOOL_USAGE: '/api/debug/tool-usage',
    // Docs
    DOCS_INDEX: '/api/docs/index',
    DOCS_GENERATE: '/api/docs/generate',
    // Chat
    CHAT: '/api/chat',
    // Orchestrate & Evaluate
    ORCHESTRATE: '/api/orchestrate',
    EVALUATE: '/api/evaluate',
    // Automation extended
    AUTOMATION_TASK_TOGGLE: '/api/automation/tasks/:taskId/toggle',
    AUTOMATION_TASK_EXECUTE: '/api/automation/tasks/:taskId/execute',
    // Logs
    LOGS_GENERAL: '/api/logs',
    // Integration WeChat QR
    INTEGRATION_WECHAT_QRCODE: '/api/integration/wechat/qrcode',
    // Harness status
    HARNESS_STATUS: '/api/tasks/harness/status',
    // Batch processing (Hermes Task 8)
    BATCH_RUN: '/api/batch/run',
    // ACP IDE integration (Hermes Task 18)
    IDE_CHAT: '/api/ide/chat',
    IDE_SESSIONS: '/api/ide/sessions',
    // RL trajectory export (Hermes Task 19)
    TRAJECTORY_EXPORT: '/api/trajectory/export',
    TRAJECTORY_STATS: '/api/trajectory/stats',
    // Tool execution (Hermes P2: image_generate / tts_speak / web_fetch)
    TOOL_EXECUTE: '/api/tools/execute',
    TOOL_LIST: '/api/tools/list',
    // File upload & access
    FILE_UPLOAD: '/api/upload',
    FILE_ACCESS: '/api/files/:filename',
    FILE_UPLOAD_HISTORY: '/api/upload/history',
    // Audio upload & STT
    AUDIO_UPLOAD: '/api/audio/upload',
    AUDIO_STREAM: '/api/audio/stream',
};
// ====================== 全局系统常量 ======================
/**
 * 全局系统常量（前后端共用）
 */
exports.SYSTEM_CONSTANTS = {
    /** 用户输入最大长度（字符数） */
    MAX_INPUT_LENGTH: 2000,
    /** WebSocket 去重缓存容量上限 */
    MAX_DEDUP_CACHE_SIZE: 1000,
    /** 活跃任务自动清理超时（毫秒） */
    ACTIVE_TASK_TIMEOUT_MS: 10 * 60 * 1000, // 10分钟
    /** 图片上传最大大小（字节，10MB） */
    MAX_IMAGE_SIZE_BYTES: 10 * 1024 * 1024,
    /** 允许的图片类型 */
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    /** 文件上传最大大小（字节，50MB） */
    MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
    /** 允许的通用文件类型 */
    ALLOWED_FILE_TYPES: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/svg+xml',
        'application/pdf',
        'text/plain',
        'text/csv',
        'text/markdown',
        'text/html',
        'application/json',
        'application/xml',
        'application/zip',
        'application/gzip',
    ],
    /** 允许的音频文件类型 */
    ALLOWED_AUDIO_TYPES: [
        'audio/wav',
        'audio/mp3',
        'audio/mpeg',
        'audio/webm',
        'audio/ogg',
        'audio/flac',
        'audio/x-m4a',
    ],
    /** 音频文件最大大小（字节，25MB） */
    MAX_AUDIO_SIZE_BYTES: 25 * 1024 * 1024,
    /** 音频流采样率 */
    AUDIO_STREAM_SAMPLE_RATE: 16000,
    /** 对话历史保存 debounce 时间 */
    HISTORY_SAVE_DEBOUNCE_MS: 2000,
    /** WebSocket 重连初始延迟 */
    WS_RECONNECT_INITIAL_DELAY_MS: 1000,
    /** WebSocket 最大重连延迟 */
    WS_RECONNECT_MAX_DELAY_MS: 30000,
};
// ====================== WebSocket 事件契约 ======================
exports.WS_EVENTS = {
    // 前端 → 后端
    CLIENT: {
        USER_INPUT: 'user_input',
        COMMAND: 'command',
        GET_STATUS: 'get_status',
        CLARIFICATION_RESPONSE: 'clarification_response',
        EXECUTION_CONFIRM: 'execution_confirm',
        CANCEL_TASK: 'cancel_task',
        AUDIO_CHUNK: 'audio_chunk',
        AUDIO_END: 'audio_end',
    },
    // 后端 → 前端
    SERVER: {
        CONNECTED: 'connected',
        RESPONSE_READY: 'response_ready',
        RESPONSE: 'response',
        ERROR: 'error',
        STATUS: 'status',
        PROACTIVE_MESSAGE: 'proactive_message',
        WEIGHT_UPDATE: 'weight_update',
        AGENT_EXECUTION_UPDATE: 'agent_execution_update',
        PERCEPTION_UPDATE: 'perception_update',
        BRAIN_STAGE_UPDATE: 'brain_stage_update',
        SKILL_EXECUTION_UPDATE: 'skill_execution_update',
        EVOLUTION_EVENT: 'evolution_event',
        CLARIFICATION_REQUEST: 'clarification_request',
        EXECUTION_PREVIEW: 'execution_preview',
        FILE_MODIFIED: 'file_modified',
        FILE_ROLLBACK: 'file_rollback',
        MULTI_FILE_MODIFIED: 'multi_file_modified',
        TOOL_TRACE: 'tool_trace',
        SERVER_LOG: 'server_log',
        USER_CORRECTION: 'user_correction',
        THINKING: 'thinking',
        PROCESSING_STATUS: 'processing_status',
        TASK_CANCELLED: 'task_cancelled',
        ASR_RESULT: 'asr_result',
        TTS_CHUNK: 'tts_chunk',
        DIALOG_STATE: 'dialog_state',
        CANCEL: 'cancel',
        ENVIRONMENT_UPDATE: 'environment_update',
        PROJECT_CHANGE: 'project_change',
        GIT_STATUS: 'git_status',
        STREAM_START: 'stream_start',
        STREAM_CHUNK: 'stream_chunk',
        STREAM_DONE: 'stream_done',
        TOOL_START: 'tool_start',
        TOOL_END: 'tool_end',
        PROGRESS: 'progress',
    },
};
// ====================== EventBus → WebSocket 桥接映射 ======================
exports.EVENTBUS_TO_WS_MAP = {
    response_ready: 'response_ready',
    agent_execution_update: 'agent_execution_update',
    proactive_interaction: 'proactive_message',
    weight_update: 'weight_update',
    weight_changed: 'weight_update',
    user_correction: 'user_correction',
    perception_update: 'perception_update',
    brain_stage_update: 'brain_stage_update',
    skill_execution_update: 'skill_execution_update',
    evolution_event: 'evolution_event',
    clarification_request: 'clarification_request',
    execution_preview: 'execution_preview',
    file_modified: 'file_modified',
    file_rollback: 'file_rollback',
    multi_file_modified: 'multi_file_modified',
    tool_trace: 'tool_trace',
    environment_update: 'environment_update',
    project_change: 'project_change',
    git_status: 'git_status',
    stream_start: 'stream_start',
    stream_chunk: 'stream_chunk',
    stream_done: 'stream_done',
};
