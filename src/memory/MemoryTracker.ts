/**
 * MemoryTracker - 记忆验证与追踪
 * 从MemoryEngine拆分出的验证和追踪逻辑：
 * 1. 记忆项验证
 * 2. 存储追踪（EventBus集成）
 * 3. 检索追踪（EventBus集成）
 */

import EventBus from '../shared/EventBus';
import {
  MemoryContent,
  MemoryItem,
  MemoryType,
  TrackedResult,
  ValidationResult,
} from './MemoryEngine';

export class MemoryTracker {
  /**
   * 验证记忆项
   * @param item 待验证的记忆项
   * @returns 验证结果
   */
  validateItem(item: MemoryItem): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!item.id || item.id.trim() === '') {
      errors.push('记忆ID不能为空');
    }

    if (!item.content) {
      errors.push('记忆内容不能为空');
    }

    if (!item.timestamp) {
      errors.push('时间戳不能为空');
    }

    if (!item.type) {
      errors.push('记忆类型不能为空');
    }

    const contentStr =
      typeof item.content === 'string'
        ? item.content
        : JSON.stringify(item.content);
    if (contentStr.length > 10000) {
      warnings.push('记忆内容过长，建议压缩');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 带追踪的存储操作
   * @param content 记忆内容
   * @param memoryType 记忆类型
   * @param storeFn 实际存储函数
   * @param scene 场景
   * @param emotion 情感
   * @param traceId 追踪ID
   */
  async storeWithTracking(
    content: MemoryContent,
    memoryType: MemoryType,
    storeFn: (
      content: MemoryContent,
      scene?: string,
      emotion?: string
    ) => Promise<MemoryItem>,
    scene?: string,
    emotion?: string,
    traceId?: string
  ): Promise<TrackedResult> {
    const finalTraceId =
      traceId ||
      'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    const startTime = Date.now();

    EventBus.startTrace(finalTraceId, 'memory_store_' + memoryType, {
      memoryType,
      scene,
      emotion,
    });

    try {
      const memoryItem = await storeFn(content, scene, emotion);

      const validation = this.validateItem(memoryItem);

      if (!validation.valid) {
        EventBus.failTrace(
          finalTraceId,
          '验证失败: ' + validation.errors.join(', ')
        );
        return {
          success: false,
          traceId: finalTraceId,
          duration: Date.now() - startTime,
          error: '验证失败: ' + validation.errors.join(', '),
        };
      }

      EventBus.completeTrace(finalTraceId, true);

      void EventBus.emit('memory_stored', memoryItem.id, memoryType);

      return {
        success: true,
        traceId: finalTraceId,
        duration: Date.now() - startTime,
        data: memoryItem,
      };
    } catch (error) {
      EventBus.failTrace(finalTraceId, (error as Error).message);
      return {
        success: false,
        traceId: finalTraceId,
        duration: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 带追踪的检索操作
   * @param query 查询文本
   * @param retrieveFn 实际检索函数
   * @param scene 场景
   * @param emotion 情感
   * @param topK 返回数量
   * @param traceId 追踪ID
   */
  async retrieveWithTracking(
    query: string,
    retrieveFn: (
      query: string,
      scene?: string,
      emotion?: string,
      topK?: number
    ) => Promise<MemoryItem[]>,
    scene?: string,
    emotion?: string,
    topK: number = 10,
    traceId?: string
  ): Promise<TrackedResult> {
    const finalTraceId =
      traceId ||
      'ret_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    const startTime = Date.now();

    EventBus.startTrace(finalTraceId, 'memory_retrieve', {
      query: query.substring(0, 50),
      scene,
      emotion,
      topK,
    });

    try {
      const results = await retrieveFn(query, scene, emotion, topK);

      EventBus.completeTrace(finalTraceId, true);

      return {
        success: true,
        traceId: finalTraceId,
        duration: Date.now() - startTime,
        data: results,
      };
    } catch (error) {
      EventBus.failTrace(finalTraceId, (error as Error).message);
      return {
        success: false,
        traceId: finalTraceId,
        duration: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }
}
