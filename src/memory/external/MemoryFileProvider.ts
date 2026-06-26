/**
 * 文件型外部记忆提供商
 *
 * 将记忆持久化到本地 JSON 文件。
 * 适用于轻量使用、测试和离线场景。
 * 实现 ExternalMemoryProvider 接口的参考实现。
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';
import { ExternalMemoryProvider } from './ExternalMemoryProvider';

interface MemoryEntry {
  key: string;
  value: string;
  timestamp: number;
}

export class MemoryFileProvider implements ExternalMemoryProvider {
  name = 'memory-file';
  private filePath: string;
  private cache: Map<string, MemoryEntry> = new Map();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string) {
    this.filePath =
      filePath || path.join(process.cwd(), 'data', 'memory-file-store.json');
    this.loadFromDisk();
  }

  async store(
    key: string,
    value: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.cache.set(key, {
        key,
        value,
        timestamp: Date.now(),
      });
      this.dirty = true;
      this.debouncedSave();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async retrieve(query: string, limit = 5): Promise<string[]> {
    const lowerQuery = query.toLowerCase();
    const results: Array<{ value: string; score: number }> = [];

    for (const entry of this.cache.values()) {
      const score = this.simpleRelevance(entry.value, lowerQuery);
      if (score > 0) {
        results.push({ value: entry.value, score });
      }
    }

    // 按相关性排序
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.value);
  }

  async delete(key: string): Promise<{ success: boolean; error?: string }> {
    if (!this.cache.has(key)) {
      return { success: false, error: `Key not found: ${key}` };
    }
    this.cache.delete(key);
    this.dirty = true;
    this.debouncedSave();
    return { success: true };
  }

  /** 清空所有记忆（管理用途） */
  clear(): number {
    const count = this.cache.size;
    this.cache.clear();
    this.dirty = true;
    this.debouncedSave();
    return count;
  }

  /** 获取条目数 */
  get size(): number {
    return this.cache.size;
  }

  /** 立即将内存数据写入磁盘（测试和管理用） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.saveToDisk();
    }
  }

  /** 释放资源（清理定时器） */
  dispose(): void {
    this.flush();
    this.cache.clear();
  }

  // ==================== 内部方法 ====================

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const entries: MemoryEntry[] = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            this.cache.set(entry.key, entry);
          }
        }
        Logger.info(
          `📂 记忆文件已加载: ${this.filePath} (${this.cache.size} 条)`,
          'MemoryFileProvider'
        );
      }
    } catch (err) {
      Logger.warn(
        `⚠️ 记忆文件加载失败: ${(err as Error).message}`,
        'MemoryFileProvider'
      );
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const entries = Array.from(this.cache.values());
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(entries, null, 2),
        'utf-8'
      );
      this.dirty = false;
    } catch (err) {
      Logger.warn(
        `⚠️ 记忆文件保存失败: ${(err as Error).message}`,
        'MemoryFileProvider'
      );
    }
  }

  private debouncedSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.dirty) this.saveToDisk();
    }, 2000);
  }

  /**
   * 简单的关键词相关性评分
   * 将查询中的每个词在记忆中匹配，返回匹配分数
   */
  private simpleRelevance(text: string, query: string): number {
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) return 0;

    const lowerText = text.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (lowerText.includes(word)) {
        score += 1;
      }
    }
    return score / words.length;
  }
}
