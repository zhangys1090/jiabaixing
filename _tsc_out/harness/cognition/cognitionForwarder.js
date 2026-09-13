"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCognitionForwarder = registerCognitionForwarder;
/**
 * D2 认知信号回灌转发器 (P2 第4轮)。
 *
 * TS 侧认知工具 (emotion_detect / self_reflect / scene_analyze) 完成后,
 * ToolRegistry 经 EventBus.emit('cognition_result', { ..., sessionId }) 发出结构化结果。
 * 本模块订阅该事件, 经 PythonAgentBridge 转发到 Python POST /v1/cognition/signal,
 * 由 Python ReAct 循环在每轮 LLM 调用前把会话级认知信号注入上下文 (元认知回灌)。
 *
 * 设计要点:
 *  - 仅当 payload 携带 sessionId 时才转发 (否则无法归属到 Python 会话, 诚实丢弃)。
 *  - 转发失败静默降级 (记录 debug), 不阻断主链路。
 *  - 幂等注册: 多次调用 registerCognitionForwarder 仅生效一次。
 */
const EventBus_1 = require("../../shared/EventBus");
const bridgeRegistry_1 = require("../../ide/bridgeRegistry");
const Logger_1 = require("../../utils/Logger");
let registered = false;
function registerCognitionForwarder() {
    if (registered)
        return;
    registered = true;
    EventBus_1.EventBus.on('cognition_result', (payload) => {
        const p = payload;
        const sessionId = p?.sessionId;
        if (!sessionId)
            return; // 无会话归属 → 不转发 (诚实降级)
        const bridge = (0, bridgeRegistry_1.getActivePythonBridge)();
        if (!bridge ||
            typeof bridge
                .sendCognitionSignal !== 'function') {
            return;
        }
        bridge
            .sendCognitionSignal(sessionId, {
            tool: p.tool,
            category: p.category,
            success: p.success,
            durationMs: p.durationMs,
            outputPreview: p.outputPreview,
            error: p.error,
            timestamp: p.timestamp,
        })
            .catch((err) => {
            // 转发失败静默降级, 仅 debug 记录 (不阻断认知工具主链路)
            Logger_1.Logger.debug(`⚠️ D2: 认知信号转发 Python 失败 (${sessionId}): ${err?.message}`, 'CognitionForwarder');
        });
    });
}
