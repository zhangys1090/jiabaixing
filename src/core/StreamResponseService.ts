/**
 * StreamResponseService — 流式推送服务
 *
 * 将完整文本分块推送，避免前端 TypewriterText 闪烁。
 * 从 JiabaixingCore.streamResponse 提取，与 Core 解耦。
 */

import { EventBus } from '../shared/EventBus';

/** 流式推送配置 */
const CHUNK_SIZE = 6;
const CHUNK_DELAY_MS = 25;

export class StreamResponseService {
  /**
   * 流式推送响应 — 将完整文本分块推送
   * @param fullText - 完整响应文本
   * @param traceId - 追踪 ID
   */
  stream(fullText: string, traceId: string): void {
    void EventBus.emit('stream_start', {
      traceId,
      totalLength: fullText.length,
      timestamp: Date.now(),
    });

    let offset = 0;

    const sendNext = (): void => {
      if (offset >= fullText.length) {
        void EventBus.emit('stream_done', {
          traceId,
          fullText,
          timestamp: Date.now(),
        });
        return;
      }

      const chunk = fullText.slice(offset, offset + CHUNK_SIZE);
      offset += CHUNK_SIZE;

      void EventBus.emit('stream_chunk', {
        traceId,
        chunk,
        offset,
        timestamp: Date.now(),
      });

      setTimeout(sendNext, CHUNK_DELAY_MS);
    };

    setTimeout(sendNext, CHUNK_DELAY_MS);
  }
}
