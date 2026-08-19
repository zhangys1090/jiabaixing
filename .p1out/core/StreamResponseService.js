"use strict";
/**
 * StreamResponseService — 流式推送服务
 *
 * 将完整文本分块推送，避免前端 TypewriterText 闪烁。
 * 从 JiabaixingCore.streamResponse 提取，与 Core 解耦。
 *
 * V2 增强：
 * - 支持取消流式推送（AbortSignal）
 * - 背压控制：检测事件总线积压，自动降速
 * - 超时保护：最长推送时间限制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamResponseService = void 0;
const EventBus_1 = require("../shared/EventBus");
const CHUNK_SIZE = 15;
const CHUNK_DELAY_MS = 35;
const MAX_STREAM_DURATION_MS = 60000;
const BACKPRESSURE_CHECK_INTERVAL = 10;
class StreamResponseService {
    constructor() {
        this.activeStreams = new Map();
    }
    /**
     * 流式推送响应 — 将完整文本分块推送
     * @param fullText - 完整响应文本
     * @param traceId - 追踪 ID
     * @param signal - 可选 AbortSignal，用于取消推送
     */
    stream(fullText, traceId, signal) {
        const streamId = traceId || `stream_${Date.now()}`;
        const abortController = new AbortController();
        const streamState = {
            abortController,
            chunkIndex: 0,
            startTime: Date.now(),
            cancelled: false,
        };
        this.activeStreams.set(streamId, streamState);
        if (signal) {
            signal.addEventListener('abort', () => {
                this.cancelStream(streamId);
            }, { once: true });
        }
        void EventBus_1.EventBus.emit('stream_start', {
            traceId: streamId,
            totalLength: fullText.length,
            timestamp: Date.now(),
        });
        let offset = 0;
        let chunkCount = 0;
        const sendNext = () => {
            if (streamState.cancelled || abortController.signal.aborted) {
                this.finalizeStream(streamId, fullText, offset, true);
                return;
            }
            if (Date.now() - streamState.startTime > MAX_STREAM_DURATION_MS) {
                this.finalizeStream(streamId, fullText, offset, true);
                return;
            }
            if (offset >= fullText.length) {
                this.finalizeStream(streamId, fullText, offset, false);
                return;
            }
            const chunk = fullText.slice(offset, offset + CHUNK_SIZE);
            offset += CHUNK_SIZE;
            chunkCount++;
            void EventBus_1.EventBus.emit('stream_chunk', {
                traceId: streamId,
                chunk,
                offset,
                timestamp: Date.now(),
            });
            streamState.chunkIndex = chunkCount;
            let delay = CHUNK_DELAY_MS;
            if (chunkCount % BACKPRESSURE_CHECK_INTERVAL === 0) {
                delay = this.applyBackpressure(delay);
            }
            setTimeout(sendNext, delay);
        };
        setTimeout(sendNext, CHUNK_DELAY_MS);
    }
    applyBackpressure(baseDelay) {
        const queueSize = this.getEventBusQueueSize();
        if (queueSize > 100) {
            return baseDelay * 4;
        }
        else if (queueSize > 50) {
            return baseDelay * 2;
        }
        else if (queueSize > 20) {
            return Math.floor(baseDelay * 1.5);
        }
        return baseDelay;
    }
    getEventBusQueueSize() {
        if (EventBus_1.EventBus.getQueueSize && typeof EventBus_1.EventBus.getQueueSize === 'function') {
            return EventBus_1.EventBus.getQueueSize();
        }
        return 0;
    }
    cancelStream(streamId) {
        const state = this.activeStreams.get(streamId);
        if (state && !state.cancelled) {
            state.cancelled = true;
            state.abortController.abort();
        }
    }
    finalizeStream(streamId, fullText, offset, wasCancelled) {
        this.activeStreams.delete(streamId);
        if (wasCancelled) {
            void EventBus_1.EventBus.emit('stream_cancelled', {
                traceId: streamId,
                deliveredLength: offset,
                totalLength: fullText.length,
                timestamp: Date.now(),
            });
        }
        else {
            void EventBus_1.EventBus.emit('stream_done', {
                traceId: streamId,
                fullText,
                timestamp: Date.now(),
            });
        }
    }
    getActiveStreamCount() {
        return this.activeStreams.size;
    }
    cancelAllStreams() {
        for (const streamId of this.activeStreams.keys()) {
            this.cancelStream(streamId);
        }
    }
}
exports.StreamResponseService = StreamResponseService;
