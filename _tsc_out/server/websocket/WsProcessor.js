"use strict";
/**
 * WebSocket 输入处理器
 * 从 index.ts 提取，专门处理用户输入的核心逻辑
 *
 * 包含：LLM 服务检查、超时控制、错误友好化、重试+熔断
 */
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
exports.processInputWithRetry = processInputWithRetry;
exports.processInputOnce = processInputOnce;
const WebSocket = __importStar(require("ws"));
const EvolutionOrchestrator_1 = require("../../evolution/EvolutionOrchestrator");
const bridgeRegistry_1 = require("../../ide/bridgeRegistry");
const Logger_1 = require("../../utils/Logger");
const WsRateLimit_1 = require("./WsRateLimit");
const WsRetry = __importStar(require("./WsRetry"));
/** 处理超时阈值（毫秒） */
const PROCESSING_TIMEOUT_MS = 120000;
/**
 * 处理用户输入（带重试+熔断）
 */
async function processInputWithRetry(input, userId, traceId, ws, core, clientIp, taskMeta) {
    const circuitBreaker = new WsRateLimit_1.WsCircuitBreaker('llm_processing');
    try {
        await processInputOnce(input, userId, traceId, ws, core, taskMeta);
        circuitBreaker.recordSuccess();
    }
    catch (error) {
        circuitBreaker.recordFailure();
        const lastError = error;
        if (WsRetry.isRetryableError(lastError)) {
            const response = WsRetry.getRetryMessage(lastError);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'response_ready',
                    data: { response, traceId },
                }));
            }
        }
        throw lastError;
    }
}
/**
 * 处理单次输入（核心逻辑）
 */
async function processInputOnce(input, userId, traceId, ws, core, taskMeta) {
    if (!core) {
        throw new Error('核心系统未初始化');
    }
    const llm = core.getLLM();
    if (!llm || !llm.isServiceAvailable()) {
        Logger_1.Logger.warn('⚠️ LLM 服务不可用，返回配置提示', 'WsProcessor');
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'response_ready',
                data: {
                    response: `抱歉，LLM 服务暂时不可用。\n\n请检查以下配置：\n1. 确认 .env 文件中的 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 已正确设置\n2. 如果使用本地模型，请确认 Ollama 服务已启动\n3. 检查网络连接是否正常`,
                    traceId,
                },
            }));
        }
        return;
    }
    const harness = core.getHarness();
    if (harness) {
        taskMeta.loopController = { abort: () => harness.abortCurrentLoop() };
    }
    try {
        const timeoutId = setTimeout(() => {
            if (!taskMeta.aborted && ws.readyState === WebSocket.OPEN) {
                Logger_1.Logger.warn(`⚠️ 处理超时 (${PROCESSING_TIMEOUT_MS}ms): traceId=${traceId}`, 'WsProcessor');
                ws.send(JSON.stringify({
                    type: 'response_ready',
                    data: {
                        response: `抱歉，处理时间过长，已自动终止。\n\n可能的原因：\n1. LLM 服务响应缓慢\n2. 任务过于复杂\n3. 网络连接不稳定\n\n请稍后重试，或简化您的请求。`,
                        traceId,
                        success: false,
                        timeout: true,
                    },
                }));
                taskMeta.aborted = true;
                if (taskMeta.loopController) {
                    taskMeta.loopController.abort();
                }
            }
        }, PROCESSING_TIMEOUT_MS);
        Logger_1.Logger.info(`🚀 开始处理输入 [${traceId}]: "${input.substring(0, 50)}..."`, 'WsProcessor');
        const result = await core.processInput(input, userId, traceId);
        clearTimeout(timeoutId);
        if (taskMeta.aborted) {
            return;
        }
        if (ws.readyState === WebSocket.OPEN) {
            const isPythonMode = (process.env.AGENT_BACKEND ?? 'python') === 'python' &&
                core?.getPythonBridgeResolver?.()?.() != null;
            if (isPythonMode) {
                Logger_1.Logger.info(`✅ 处理完成, traceId: ${result.traceId}（Python 后端模式：响应由 EventBus WS 通道推送，跳过 response_ready）`, 'WsProcessor');
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'response_ready_ack',
                            data: {
                                traceId: result.traceId || traceId,
                                success: true,
                                source: 'python_bridge',
                            },
                        }));
                    }
                }, 50);
            }
            else {
                Logger_1.Logger.info(`✅ 处理完成, traceId: ${result.traceId}（TS 本地模式：发送 response_ready 兜底）`, 'WsProcessor');
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'response_ready',
                            data: {
                                response: result.response,
                                traceId: result.traceId || traceId,
                                success: true,
                                quality: result.quality ?? 0.7,
                                loopRounds: result.loopRounds,
                                toolCallsCount: result.toolCallsCount,
                            },
                        }));
                    }
                }, 100);
            }
            // 记录交互数据到进化引擎（python 模式经 PythonAgentBridge 委派；local 模式用 TS 编排器）
            try {
                const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
                if (bridge) {
                    void bridge
                        .submitFeedback({
                        kind: 'interaction',
                        traceId: result.traceId || traceId,
                        input,
                        response: result.response,
                        success: true,
                        qualityScore: result
                            .quality || 0.7,
                        executionDuration: 0,
                        toolCalls: [],
                        scene: 'websocket',
                        userId,
                    })
                        .catch((err) => Logger_1.Logger.warn('记录交互到进化引擎失败', 'WsProcessor', err));
                }
                else {
                    const orchestrator = EvolutionOrchestrator_1.EvolutionOrchestrator.getInstance();
                    orchestrator.recordInteraction({
                        traceId: result.traceId || traceId,
                        input,
                        response: result.response,
                        success: true,
                        qualityScore: result
                            .quality || 0.7,
                        executionDuration: 0,
                        toolCalls: [],
                        scene: 'websocket',
                        userId,
                    });
                }
            }
            catch {
                Logger_1.Logger.debug('进化数据记录失败(WS)', 'WsProcessor');
            }
        }
    }
    catch (error) {
        Logger_1.Logger.error('❌ processInputOnce 执行失败', error, 'WsProcessor');
        if (ws.readyState === WebSocket.OPEN) {
            const errorMsg = error.message;
            const userFriendlyMessage = friendlyErrorMessage(errorMsg);
            ws.send(JSON.stringify({
                type: 'response_ready',
                data: {
                    response: userFriendlyMessage,
                    traceId,
                    success: false,
                },
            }));
        }
        throw error;
    }
}
/**
 * 将技术错误信息转换为用户友好的提示
 */
function friendlyErrorMessage(errorMsg) {
    if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('连接')) {
        return `抱歉，无法连接到 AI 服务。\n\n请检查：\n1. 网络连接是否正常\n2. API Key 是否正确配置\n3. LLM 服务是否可用`;
    }
    if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
        return `抱歉，AI 服务响应超时。\n\n可能原因：\n1. 服务器负载过高\n2. 网络延迟\n3. 请求队列拥堵\n\n请稍后重试。`;
    }
    if (errorMsg.includes('API') ||
        errorMsg.includes('401') ||
        errorMsg.includes('认证')) {
        return `抱歉，API 认证失败。\n\n请检查 .env 文件中的 API Key 配置是否正确。`;
    }
    return '抱歉，处理过程中出现了错误，请稍后重试。';
}
