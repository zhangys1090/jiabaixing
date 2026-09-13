"use strict";
/**
 * EventBus 事件监听注册
 * 将 EventBus 事件桥接到 WebSocket 广播和 Webhook 推送
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupEventBus = setupEventBus;
const IntegrationManager_1 = require("../integration/IntegrationManager");
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
function setupEventBus(wss, core) {
    const broadcast = (data) => {
        if (!wss)
            return;
        const message = JSON.stringify(data);
        wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                client.send(message);
            }
        });
    };
    const integrationManager = IntegrationManager_1.IntegrationManager.getInstance(true);
    /**
     * 广播事件到 WebSocket 并推送到 Webhook
     * @param eventType - 事件类型
     * @param wsData - 推送到 WebSocket 的数据
     * @param webhookData - 推送到 Webhook 的数据（默认与 wsData 相同）
     */
    const broadcastAndPush = (eventType, wsData, webhookData) => {
        broadcast(wsData);
        void integrationManager.pushToWebhooks(eventType, webhookData ?? wsData);
    };
    const registeredEvents = new Set();
    const registerOnce = (event, handler) => {
        if (registeredEvents.has(event))
            return;
        registeredEvents.add(event);
        EventBus_1.EventBus.on(event, handler);
    };
    registerOnce('weight_update', (data) => {
        const payload = data;
        broadcastAndPush('weight_update', {
            type: 'weight_update',
            data: { weights: payload.weights || {} },
        });
    });
    registerOnce('agent_execution_update', (data) => {
        const payload = data;
        broadcastAndPush('agent_execution_update', {
            type: 'agent_execution_update',
            data: {
                traceId: payload.traceId || 'unknown',
                phase: payload.phase || 'unknown',
                status: payload.status || 'unknown',
                result: payload.result,
                timestamp: payload.timestamp || new Date().toISOString(),
                message: payload.message,
                roundsUsed: payload.roundsUsed,
                toolCallsCount: payload.toolCallsCount,
                toolName: payload.toolName,
                toolSuccess: payload.toolSuccess,
                duration: payload.duration,
            },
        });
    });
    registerOnce('proactive_interaction', async (data) => {
        const payload = data;
        Logger_1.Logger.info(`🔔 收到主动交互信号: 原因=${payload.reason}, 场景=${payload.scene}, 优先级=${payload.priority}`, 'Main');
        try {
            if (!core) {
                Logger_1.Logger.warn('核心系统未初始化，无法生成主动消息', 'Main');
                return;
            }
            const message = await core.generateProactiveMessage({
                reason: payload.reason || 'scheduled',
                context: payload.context || '',
                scene: payload.scene || '休闲',
                isEmotionBased: payload.isEmotionBased || false,
            });
            if (message) {
                broadcastAndPush('proactive_message', {
                    type: 'proactive_message',
                    data: {
                        message,
                        reason: payload.reason,
                        scene: payload.scene,
                        timestamp: Date.now(),
                    },
                });
                Logger_1.Logger.info(`📤 主动消息已推送: "${message.substring(0, 50)}..."`, 'Main');
            }
        }
        catch (error) {
            Logger_1.Logger.warn(`⚠️ 生成主动消息失败: ${error.message}`, 'Main');
        }
    });
    registerOnce('weight_changed', (data) => {
        const payload = data;
        broadcastAndPush('weight_changed', {
            type: 'weight_update',
            data: {
                toolId: payload.toolId || '',
                oldWeight: payload.oldWeight,
                newWeight: payload.newWeight,
                reason: payload.reason || '',
                timestamp: payload.timestamp || Date.now(),
                updateType: 'single',
            },
        });
    });
    registerOnce('user_correction', (data) => {
        broadcastAndPush('user_correction', { type: 'user_correction', data });
    });
    registerOnce('perception_update', (data) => {
        const payload = data;
        broadcastAndPush('perception_update', {
            type: 'perception_update',
            data: {
                traceId: payload.traceId || 'unknown',
                modality: payload.modality || 'text',
                status: payload.status || 'unknown',
                progress: payload.progress,
                result: payload.result,
                confidence: payload.confidence,
                error: payload.error,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('brain_stage_update', (data) => {
        const payload = data;
        broadcastAndPush('brain_stage_update', {
            type: 'brain_stage_update',
            data: {
                traceId: payload.traceId || 'unknown',
                stage: payload.stage || 'unknown',
                status: payload.status || 'unknown',
                duration: payload.duration,
                result: payload.result,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('skill_execution_update', (data) => {
        const payload = data;
        broadcastAndPush('skill_execution_update', {
            type: 'skill_execution_update',
            data: {
                traceId: payload.traceId || 'unknown',
                skillName: payload.skillName || 'unknown',
                step: payload.step || 'started',
                attempt: payload.attempt,
                maxRetries: payload.maxRetries,
                duration: payload.duration,
                error: payload.error,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('evolution_event', (data) => {
        const payload = data;
        broadcastAndPush('evolution_event', {
            type: 'evolution_event',
            data: {
                type: payload.type || 'quality_assessed',
                traceId: payload.traceId,
                score: payload.score,
                description: payload.description || '',
                metrics: payload.metrics,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('clarification_request', (data) => {
        const payload = data;
        broadcastAndPush('clarification_request', {
            type: 'clarification_request',
            data: {
                traceId: payload.traceId || 'unknown',
                question: payload.question || '',
                options: payload.options || [],
                context: payload.context || '',
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('execution_preview', (data) => {
        const payload = data;
        broadcastAndPush('execution_preview', {
            type: 'execution_preview',
            data: {
                traceId: payload.traceId || 'unknown',
                summary: payload.summary || '',
                changes: payload.changes || [],
                estimatedTime: payload.estimatedTime,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('file_modified', (data) => {
        const payload = data;
        broadcastAndPush('file_modified', {
            type: 'file_modified',
            data: {
                traceId: payload.traceId || 'unknown',
                filePath: payload.filePath || '',
                changeType: payload.changeType || 'modified',
                edits: payload.edits,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('file_rollback', (data) => {
        const payload = data;
        broadcastAndPush('file_rollback', {
            type: 'file_rollback',
            data: {
                traceId: payload.traceId || 'unknown',
                filePath: payload.filePath || '',
                success: payload.success ?? true,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('multi_file_modified', (data) => {
        const payload = data;
        broadcastAndPush('multi_file_modified', {
            type: 'multi_file_modified',
            data: {
                traceId: payload.traceId || 'unknown',
                files: payload.files || [],
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('tool_trace', (data) => {
        const payload = data;
        broadcastAndPush('tool_trace', {
            type: 'tool_trace',
            data: {
                timestamp: payload.timestamp || new Date().toISOString(),
                traceId: payload.traceId || 'unknown',
                toolCallId: payload.toolCallId || '',
                toolName: payload.toolName || '',
                status: payload.status || 'started',
                duration: payload.duration || 0,
                success: payload.success ?? null,
                errorMessage: payload.errorMessage ?? null,
            },
        });
    });
    registerOnce('response_ready', (data) => {
        const payload = data;
        Logger_1.Logger.info(`📡 EventBus广播 response_ready: traceId=${payload.traceId}, success=${payload.success}, 响应长度=${payload.response?.length || 0}`, 'EventBus');
        broadcastAndPush('response_ready', {
            type: 'response_ready',
            data: {
                response: payload.response || '',
                traceId: payload.traceId || '',
                success: payload.success ?? false,
            },
        });
    });
    registerOnce('stream_start', (data) => {
        const payload = data;
        broadcastAndPush('stream_start', {
            type: 'stream_start',
            data: {
                traceId: payload.traceId || '',
                totalLength: payload.totalLength || 0,
                timestamp: payload.timestamp || Date.now(),
            },
        });
    });
    registerOnce('stream_chunk', (data) => {
        const payload = data;
        broadcastAndPush('stream_chunk', {
            type: 'stream_chunk',
            data: {
                traceId: payload.traceId || '',
                chunk: payload.chunk || '',
                offset: payload.offset || 0,
                timestamp: payload.timestamp || Date.now(),
            },
        });
    });
    registerOnce('stream_done', (data) => {
        const payload = data;
        broadcastAndPush('stream_done', {
            type: 'stream_done',
            data: {
                traceId: payload.traceId || '',
                fullText: payload.fullText || '',
                timestamp: payload.timestamp || Date.now(),
            },
        });
    });
    registerOnce('proactive_message', (data) => {
        const payload = data;
        broadcastAndPush('proactive_message', {
            type: 'proactive_message',
            data: {
                message: payload.message || payload.reason || '',
                timestamp: new Date().toISOString(),
            },
        });
    });
    registerOnce('environment_update', (data) => {
        const payload = data;
        broadcastAndPush('environment_update', {
            type: 'environment_update',
            data: {
                timestamp: payload.timestamp || new Date().toISOString(),
                activeEnv: payload.activeEnv || 'unknown',
                foregroundWindow: payload.foregroundWindow || null,
            },
        });
    });
    registerOnce('project_change', (data) => {
        const payload = data;
        broadcastAndPush('project_change', {
            type: 'project_change',
            data: {
                type: payload.type,
                repo: payload.repo,
                detail: payload.detail,
                timestamp: payload.timestamp || new Date().toISOString(),
            },
        });
    });
    registerOnce('git_status', (data) => {
        const payload = data;
        broadcastAndPush('git_status', {
            type: 'git_status',
            data: {
                timestamp: payload.timestamp || new Date().toISOString(),
                repos: payload.repos || [],
            },
        });
    });
    Logger_1.Logger.on('log', (entry) => {
        if (entry.level === 'error' || entry.level === 'fatal') {
            broadcast({
                type: 'server_log',
                data: entry,
            });
        }
    });
    Logger_1.Logger.info(`✅ EventBus 监听器已注册（防重复机制已启用，共 ${registeredEvents.size} 个事件）`, 'EventBus');
    return broadcast;
}
