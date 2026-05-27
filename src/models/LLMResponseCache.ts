import crypto from 'crypto';
import { Logger } from '../utils/Logger';

export class LLMResponseCache {
  private cache: Map<string, { text: string; timestamp: number }> = new Map();
  private static readonly MAX_CACHE_SIZE = 100;
  private cacheTTL: number = 120000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttl?: number) {
    if (ttl !== undefined) {
      this.cacheTTL = ttl;
    }
    this.startCleanup();
  }

  generateKey(input: string, systemPrompt?: string): string {
    const data = JSON.stringify({ input, systemPrompt });
    return crypto.createHash('md5').update(data).digest('hex');
  }

  get(key: string): string | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      Logger.debug(`缓存命中: ${key.substring(0, 8)}...`, 'LLMResponseCache');
      return cached.text;
    }
    return null;
  }

  set(key: string, text: string): void {
    this.cache.set(key, { text, timestamp: Date.now() });
    
    if (this.cache.size > LLMResponseCache.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, value] of this.cache) {
        if (now - value.timestamp > this.cacheTTL) {
          this.cache.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        Logger.debug(`清理过期缓存: ${cleaned} 项`, 'LLMResponseCache');
      }
    }, 60000);
  }

  clear(): void {
    this.cache.clear();
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
