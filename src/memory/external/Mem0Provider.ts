/**
 * Mem0 外部记忆提供商
 *
 * 连接 Mem0 API（https://mem0.ai）实现跨会话持久记忆。
 * 需要 MEM0_API_KEY 环境变量。
 */

import { Logger } from '../../utils/Logger';
import { ExternalMemoryProvider } from './ExternalMemoryProvider';

export interface Mem0Config {
  apiKey: string;
  baseUrl?: string;
  userId?: string;
}

export class Mem0Provider implements ExternalMemoryProvider {
  name = 'mem0';
  private apiKey: string;
  private baseUrl: string;
  private userId: string;

  constructor(config: Mem0Config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.mem0.ai/v1';
    this.userId = config.userId || 'default';
  }

  async store(
    key: string,
    value: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key,
          text: value,
          user_id: this.userId,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          success: false,
          error: `Mem0 API error (${res.status}): ${body.substring(0, 200)}`,
        };
      }

      Logger.debug(
        `💾 Mem0 记忆已存储: key=${key.substring(0, 32)}`,
        'Mem0Provider'
      );
      return { success: true };
    } catch (err) {
      Logger.error(`Mem0 存储失败`, err as Error, 'Mem0Provider');
      return { success: false, error: (err as Error).message };
    }
  }

  async retrieve(query: string, limit = 10): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/memories/?query=${encodeURIComponent(query)}&user_id=${this.userId}&limit=${limit}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        Logger.warn(`Mem0 检索失败: ${res.status}`, 'Mem0Provider');
        return [];
      }

      const data = (await res.json()) as { results?: Array<{ text: string }> };
      return data.results?.map((r) => r.text) || [];
    } catch (err) {
      Logger.warn(`Mem0 检索异常: ${(err as Error).message}`, 'Mem0Provider');
      return [];
    }
  }

  async delete(key: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${this.baseUrl}/memories/?key=${encodeURIComponent(key)}&user_id=${this.userId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Token ${this.apiKey}`,
          },
        }
      );

      if (!res.ok) {
        return { success: false, error: `Mem0 delete error: ${res.status}` };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
